/**
 * Decisions are `user_input_request` items with a `decision` card, so answers
 * reuse the question flow. A blocking request keeps the agent's tool call open
 * until the user picks an option or writes back; a non-blocking one returns at
 * once and the answer arrives later as a queued message.
 */
import {
  CommandId,
  DECISION_QUESTION_ID,
  type DecisionQueue,
  DecisionQueueError,
  type DecisionQueueInput,
  type DecisionQueueItem,
  NodeId,
  type OrchestrationV2Decision,
  type OrchestrationV2DecisionMedia,
  type OrchestrationV2StoredEvent,
  type ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createAttachmentId } from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import * as ServerConfig from "../config.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const POLL_INTERVAL_MS = 500;
// Claude gives T3's MCP calls 65 minutes; return before the provider gives up.
const DEFAULT_WAIT_MINUTES = 50;
const MAX_WAIT_MINUTES = 60;
const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;
const QUEUE_REFRESH_DEBOUNCE_MS = 150;

const MEDIA_MIME_TYPES: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
};

export class DecisionError extends Schema.TaggedError<DecisionError>()("DecisionError", {
  reason: Schema.Literals([
    "no_active_run",
    "media_not_found",
    "media_unsupported",
    "media_too_large",
    "not_found",
    "settled",
    "storage",
    "orchestration",
  ]),
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "no_active_run":
        return "Decisions can only be requested from an active turn in this thread.";
      case "media_not_found":
        return `Media file not found: ${this.path ?? "unknown path"}. Pass absolute paths.`;
      case "media_unsupported":
        return `Unsupported media type: ${this.path ?? "unknown path"}. Use video (mp4, mov, webm), images (png, jpg, gif, webp), audio (mp3, wav, m4a) or pdf.`;
      case "media_too_large":
        return `Media file is larger than 1 GiB: ${this.path ?? "unknown path"}. Transcode it smaller first.`;
      case "not_found":
        return "That decision was not found in this thread.";
      case "settled":
        return "That decision is already answered or dismissed. Ask a new one if you still need input.";
      case "storage":
        return "Could not store the decision media.";
      case "orchestration":
        return "Could not record the decision.";
    }
  }
}

export interface DecisionOption {
  readonly label: string;
  readonly description: string;
}

export interface DecisionMediaInput {
  readonly path: string;
  readonly label?: string | undefined;
  readonly caption?: string | undefined;
}

export interface DecisionCaller {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export type DecisionOutcome =
  | { readonly status: "posted"; readonly decisionId: RuntimeRequestId }
  | {
      readonly status: "answered";
      readonly decisionId: RuntimeRequestId;
      readonly answer: string;
    }
  | {
      readonly status: "user_message";
      readonly decisionId: RuntimeRequestId;
      readonly message: string;
    }
  | { readonly status: "dismissed"; readonly decisionId: RuntimeRequestId }
  | { readonly status: "no_answer_yet"; readonly decisionId: RuntimeRequestId };

export class DecisionService extends Context.Service<
  DecisionService,
  {
    readonly request: (
      caller: DecisionCaller,
      input: {
        readonly title: string;
        readonly context: string;
        readonly options: ReadonlyArray<DecisionOption>;
        readonly recommendedOption?: string | undefined;
        readonly reversible: boolean;
        readonly blocking: boolean;
        readonly media: ReadonlyArray<DecisionMediaInput>;
        readonly waitMinutes?: number | undefined;
      },
    ) => Effect.Effect<DecisionOutcome, DecisionError>;
    readonly reply: (
      caller: DecisionCaller,
      input: {
        readonly decisionId: RuntimeRequestId;
        readonly message: string;
        readonly options?: ReadonlyArray<DecisionOption> | undefined;
        readonly recommendedOption?: string | undefined;
        readonly media?: ReadonlyArray<DecisionMediaInput> | undefined;
        readonly wait: boolean;
        readonly waitMinutes?: number | undefined;
      },
    ) => Effect.Effect<DecisionOutcome, DecisionError>;
    readonly subscribeQueue: (
      input: DecisionQueueInput,
    ) => Stream.Stream<DecisionQueue, DecisionQueueError>;
  }
>()("t3/decisions/DecisionService") {}

const isQueueEvent = (stored: OrchestrationV2StoredEvent) => {
  const event = stored.event;
  switch (event.type) {
    case "runtime-request.updated":
      return event.payload.kind === "user_input";
    case "turn-item.updated":
      return event.payload.type === "user_input_request";
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.metadata-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return true;
    default:
      return false;
  }
};

const answerText = (answer: unknown): string =>
  typeof answer === "string"
    ? answer
    : Array.isArray(answer)
      ? answer.filter((entry) => typeof entry === "string").join(", ")
      : "";

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projectionStore = yield* ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const eventSink = yield* EventSinkV2;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const newId = crypto
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => new DecisionError({ reason: "orchestration", cause })));

  const dispatch = (command: Parameters<typeof threadManagement.dispatch>[0]) =>
    threadManagement
      .dispatch(command)
      .pipe(Effect.mapError((cause) => new DecisionError({ reason: "orchestration", cause })));

  const storeMedia = Effect.fn("DecisionService.storeMedia")(function* (
    threadId: ThreadId,
    media: DecisionMediaInput,
  ) {
    const sourcePath = path.resolve(media.path);
    const extension = path.extname(sourcePath).slice(1).toLowerCase();
    const mimeType = MEDIA_MIME_TYPES[extension];
    if (mimeType === undefined) {
      return yield* new DecisionError({ reason: "media_unsupported", path: media.path });
    }
    const info = yield* fileSystem
      .stat(sourcePath)
      .pipe(
        Effect.mapError(
          (cause) => new DecisionError({ reason: "media_not_found", path: media.path, cause }),
        ),
      );
    if (info.type !== "File") {
      return yield* new DecisionError({ reason: "media_not_found", path: media.path });
    }
    const sizeBytes = Number(info.size);
    if (sizeBytes > MAX_MEDIA_BYTES) {
      return yield* new DecisionError({ reason: "media_too_large", path: media.path });
    }
    const attachmentId = createAttachmentId(threadId, extension);
    const targetPath =
      attachmentId === null
        ? null
        : resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${attachmentId}.${extension}`,
          });
    if (attachmentId === null || targetPath === null) {
      return yield* new DecisionError({ reason: "storage", path: media.path });
    }
    // Copied, so the card still plays after the agent moves or deletes its render.
    yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true }).pipe(
      Effect.andThen(fileSystem.copyFile(sourcePath, targetPath)),
      Effect.mapError((cause) => new DecisionError({ reason: "storage", path: media.path, cause })),
    );
    return {
      attachmentId,
      name: path.basename(sourcePath),
      mimeType,
      sizeBytes,
      ...(media.label === undefined ? {} : { label: media.label }),
      ...(media.caption === undefined ? {} : { caption: media.caption }),
    } satisfies OrchestrationV2DecisionMedia;
  });

  const readDecision = Effect.fn("DecisionService.readDecision")(function* (
    threadId: ThreadId,
    decisionId: RuntimeRequestId,
  ) {
    const records = yield* threadManagement
      .getThreadRecords(threadId, ["runs", "runtimeRequests", "turnItems"], {
        turnItemTypes: ["user_input_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new DecisionError({ reason: "orchestration", cause })));
    const request = records.runtimeRequests.find((candidate) => candidate.id === decisionId);
    const item = records.turnItems.find(
      (candidate) => candidate.type === "user_input_request" && candidate.requestId === decisionId,
    );
    if (request === undefined || item?.type !== "user_input_request" || !item.decision) {
      return yield* new DecisionError({ reason: "not_found" });
    }
    return { request, item, decision: item.decision, runs: records.runs };
  });

  const setAgentWaiting = (threadId: ThreadId, decisionId: RuntimeRequestId, waiting: boolean) =>
    newId.pipe(
      Effect.flatMap((uuid) =>
        dispatch({
          type: "decision.update",
          commandId: CommandId.make(`decision-wait:${uuid}`),
          threadId,
          requestId: decisionId,
          agentWaiting: waiting,
        }),
      ),
    );

  /** Settles a waiting call: the answer, the user's reply, a dismissal, or nothing yet. */
  const settledOutcome = (
    decisionId: RuntimeRequestId,
    state: { readonly request: { readonly status: string; readonly answers?: unknown } } & {
      readonly decision: OrchestrationV2Decision;
    },
    seenMessages: number,
  ): DecisionOutcome | undefined => {
    if (state.request.status === "resolved") {
      const answers = state.request.answers as Record<string, unknown> | undefined;
      return {
        status: "answered",
        decisionId,
        answer: answerText(answers?.[DECISION_QUESTION_ID]),
      };
    }
    if (state.request.status !== "pending") return { status: "dismissed", decisionId };
    if (state.decision.agentWaiting) return undefined;
    const replies = state.decision.messages
      .slice(seenMessages)
      .filter((message) => message.author === "user");
    if (replies.length === 0) return undefined;
    return {
      status: "user_message",
      decisionId,
      message: replies.map((message) => message.text).join("\n\n"),
    };
  };

  const waitForUser = Effect.fn("DecisionService.waitForUser")(function* (
    threadId: ThreadId,
    decisionId: RuntimeRequestId,
    seenMessages: number,
    waitMinutes: number | undefined,
  ) {
    const minutes = Math.min(Math.max(waitMinutes ?? DEFAULT_WAIT_MINUTES, 1), MAX_WAIT_MINUTES);
    const release = setAgentWaiting(threadId, decisionId, false).pipe(Effect.ignore);
    const outcome = yield* Effect.gen(function* () {
      while (true) {
        const state = yield* readDecision(threadId, decisionId);
        const settled = settledOutcome(decisionId, state, seenMessages);
        if (settled !== undefined) return settled;
        if (!state.decision.agentWaiting) {
          return { status: "no_answer_yet", decisionId } satisfies DecisionOutcome;
        }
        yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
      }
    }).pipe(
      Effect.timeoutOption(Duration.minutes(minutes)),
      // An aborted tool call can no longer take the answer, so it must go out as a message.
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : release)),
    );
    if (Option.isSome(outcome)) return outcome.value;
    yield* release;
    // The user may have answered between the last poll and the release.
    const state = yield* readDecision(threadId, decisionId);
    return (
      settledOutcome(decisionId, state, seenMessages) ??
      ({ status: "no_answer_yet", decisionId } satisfies DecisionOutcome)
    );
  });

  const request: DecisionService["Service"]["request"] = Effect.fn("DecisionService.request")(
    function* (caller, input) {
      const records = yield* threadManagement
        .getThreadRecords(caller.threadId, ["runs"], { turnItemTypes: [], messageRoles: [] })
        .pipe(Effect.mapError((cause) => new DecisionError({ reason: "orchestration", cause })));
      const run = ThreadManagementService.latestActiveRun(records);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== caller.providerInstanceId
      ) {
        return yield* new DecisionError({ reason: "no_active_run" });
      }
      const media = yield* Effect.forEach(input.media, (item) => storeMedia(caller.threadId, item));
      const uuid = yield* newId;
      const decisionId = RuntimeRequestId.make(`decision:${uuid}`);
      yield* dispatch({
        type: "decision.record",
        commandId: CommandId.make(`decision-record:${uuid}`),
        threadId: caller.threadId,
        runId: run.id,
        parentNodeId: run.rootNodeId,
        requestId: decisionId,
        requestNodeId: NodeId.make(`node:decision:${uuid}`),
        turnItemId: TurnItemId.make(`turn-item:decision:${uuid}`),
        title: input.title,
        options: input.options,
        decision: {
          context: input.context,
          ...(input.recommendedOption === undefined
            ? {}
            : { recommendedOption: input.recommendedOption }),
          reversible: input.reversible,
          blocking: input.blocking,
          media,
          messages: [],
          agentWaiting: input.blocking,
        },
      });
      if (!input.blocking) return { status: "posted", decisionId } satisfies DecisionOutcome;
      return yield* waitForUser(caller.threadId, decisionId, 0, input.waitMinutes);
    },
  );

  const reply: DecisionService["Service"]["reply"] = Effect.fn("DecisionService.reply")(
    function* (caller, input) {
      const current = yield* readDecision(caller.threadId, input.decisionId);
      if (current.request.status !== "pending") {
        return yield* new DecisionError({ reason: "settled" });
      }
      const media =
        input.media === undefined
          ? undefined
          : yield* Effect.forEach(input.media, (item) => storeMedia(caller.threadId, item));
      const uuid = yield* newId;
      yield* dispatch({
        type: "decision.update",
        commandId: CommandId.make(`decision-reply:${uuid}`),
        threadId: caller.threadId,
        requestId: input.decisionId,
        agentMessage: input.message,
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.recommendedOption === undefined
          ? {}
          : { recommendedOption: input.recommendedOption }),
        ...(media === undefined ? {} : { media }),
        agentWaiting: input.wait,
      });
      if (!input.wait) {
        return { status: "posted", decisionId: input.decisionId } satisfies DecisionOutcome;
      }
      // Count the agent's own reply as seen so only newer user messages return.
      return yield* waitForUser(
        caller.threadId,
        input.decisionId,
        current.decision.messages.length + 1,
        input.waitMinutes,
      );
    },
  );

  const readQueue = Effect.fn("DecisionService.readQueue")(
    function* (input: DecisionQueueInput) {
      const [questions, answeredCount, projects] = yield* Effect.all([
        projectionStore.getPendingQuestions(),
        projectionStore.countAnsweredQuestions(DateTime.makeUnsafe(input.answeredSince)),
        projectStore.listShells(),
      ]);
      const projectTitles = new Map(projects.map((project) => [project.id, project.title]));
      const items = questions.map(({ thread, request, item }): DecisionQueueItem => ({
        threadId: thread.id,
        threadTitle: thread.title,
        projectId: thread.projectId,
        projectTitle: projectTitles.get(thread.projectId) ?? "",
        providerInstanceId: thread.modelSelection.instanceId,
        requestId: request.id,
        turnItemId: item.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions,
        ...(item.decision === undefined ? {} : { decision: item.decision }),
      }));
      return { items, answeredCount } satisfies DecisionQueue;
    },
    Effect.mapError((cause) => new DecisionQueueError({ cause })),
  );

  const subscribeQueue: DecisionService["Service"]["subscribeQueue"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Read the sequence first so a change committed during the first read still triggers a refresh.
        const afterSequence = yield* eventSink.latestSequence();
        return Stream.concat(
          Stream.fromEffect(readQueue(input)),
          eventSink.stream({ afterSequence }).pipe(
            Stream.mapError((cause) => new DecisionQueueError({ cause })),
            Stream.filter(isQueueEvent),
            Stream.debounce(Duration.millis(QUEUE_REFRESH_DEBOUNCE_MS)),
            Stream.mapEffect(() => readQueue(input)),
          ),
        );
      }).pipe(Effect.mapError((cause) => new DecisionQueueError({ cause }))),
    );

  // No tool call survives a restart, so a card still marked as waiting would swallow the answer.
  yield* projectionStore.getPendingQuestions().pipe(
    Effect.flatMap((questions) =>
      Effect.forEach(
        questions.filter(({ item }) => item.decision?.agentWaiting === true),
        ({ thread, request: pending }) => setAgentWaiting(thread.id, pending.id, false),
        { discard: true },
      ),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not release decisions left waiting by a restart", {
        error: error.message,
      }),
    ),
    Effect.forkDetach,
  );

  return DecisionService.of({ request, reply, subscribeQueue });
});

export const layer = Layer.effect(DecisionService, make);
