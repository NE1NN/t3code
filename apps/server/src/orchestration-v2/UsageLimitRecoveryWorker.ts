import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ClaudeAccountBalancer from "../provider/ClaudeAccountBalancer.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

/**
 * Continues a thread stopped by its account's usage limit on another account
 * now, instead of waiting for the reset. Accounts sharing a config directory
 * resume the same native conversation.
 */
export function accountMoveCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  instanceId: ProviderInstanceId,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    thread.modelSelection.instanceId === instanceId
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`account-move:${identity}`),
    messageId: MessageId.make(`account-move:${identity}`),
    threadId: thread.id,
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: { ...thread.modelSelection, instanceId },
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const balancer = yield* ClaudeAccountBalancer.ClaudeAccountBalancer;

  const moveToFreeAccount = Effect.fn("UsageLimitRecoveryWorker.moveToFreeAccount")(function* (
    thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  ) {
    const instanceId = thread.modelSelection.instanceId;
    if (thread.usageLimitResetAt) {
      yield* balancer.noteLimited({ instanceId, resetAt: thread.usageLimitResetAt });
    }
    const move = yield* balancer.chooseMove({ projectId: thread.projectId, instanceId });
    const command = move === undefined ? null : accountMoveCommand(thread, move.instanceId);
    if (move === undefined || command === null) return false;
    yield* threads.dispatch(command);
    yield* balancer.recordMove({
      id: command.commandId,
      threadId: thread.id,
      threadTitle: thread.title,
      fromInstanceId: instanceId,
      toInstanceId: move.instanceId,
      reason: move.reason,
    });
    return true;
  });

  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const balancing = preferences.claudeBalancing.enabled;
    if (balancing) yield* balancer.refreshStaleReadings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      // Balancing needs every freshly limited thread, armed for auto-resume or not.
      autoResume: preferences.autoResumeLimitedThreads || balancing,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      if (balancing) {
        const moved = yield* moveToFreeAccount(thread).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.limit-recovery.account-move-failed", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (moved) continue;
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
