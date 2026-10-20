import {
  type ClaudeAccountMove,
  type ClaudeAccountMoveReason,
  type ClaudeAccountStatus,
  type ClaudeAccountUsageWindow,
  type ClaudeBalancingStatus,
  type ModelSelection,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSettingsService from "../serverSettings.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const LIMITED_PERCENT = 100;
/** Moving a running thread loses its prompt cache, so only a clear weekly lead justifies it. */
const AHEAD_POINTS = 25;
const STALE_READING_MS = 5 * 60_000;
const KEPT_MOVES = 200;
const LISTED_MOVES = 50;

export interface AccountReading {
  readonly instanceId: ProviderInstanceId;
  readonly fiveHour: number | null;
  readonly weekly: number | null;
  readonly limited: boolean;
}

export interface MoveDecision {
  readonly instanceId: ProviderInstanceId;
  readonly reason: Exclude<ClaudeAccountMoveReason, "new_thread">;
}

const activeWindow = (
  provider: ServerProvider,
  id: "five_hour" | "seven_day",
  nowMs: number,
): ClaudeAccountUsageWindow | null => {
  const window = provider.usageLimits?.windows.find((candidate) => candidate.id === id);
  if (window === undefined) return null;
  // A window whose reset has passed is empty, even if no probe has said so yet.
  if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs) {
    return { usedPercent: 0 };
  }
  return {
    usedPercent: window.usedPercent,
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
};

export function accountReading(
  provider: ServerProvider,
  limitedUntilMs: number | undefined,
  nowMs: number,
): AccountReading {
  const fiveHour = activeWindow(provider, "five_hour", nowMs)?.usedPercent ?? null;
  const weekly = activeWindow(provider, "seven_day", nowMs)?.usedPercent ?? null;
  return {
    instanceId: provider.instanceId,
    fiveHour,
    weekly,
    limited:
      (fiveHour ?? 0) >= LIMITED_PERCENT ||
      (weekly ?? 0) >= LIMITED_PERCENT ||
      (limitedUntilMs !== undefined && limitedUntilMs > nowMs),
  };
}

/** An account with no reading counts as unused. */
export const accountLoad = (reading: AccountReading): number =>
  Math.max(reading.fiveHour ?? 0, reading.weekly ?? 0);

const usable = (provider: ServerProvider) =>
  provider.driver === CLAUDE_DRIVER &&
  provider.enabled &&
  provider.installed &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.auth.status !== "unauthenticated";

/**
 * Accounts that share native history with `instanceId`, so a thread can move
 * between them and resume. Empty when `instanceId` is not a Claude account.
 */
export function balancingGroup(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ServerProvider> {
  const requested = providers.find((provider) => provider.instanceId === instanceId);
  if (requested === undefined || requested.driver !== CLAUDE_DRIVER) return [];
  const groupKey = requested.continuation?.groupKey;
  if (groupKey === undefined) return [requested];
  return providers.filter(
    (provider) =>
      provider.instanceId === instanceId ||
      (usable(provider) && provider.continuation?.groupKey === groupKey),
  );
}

const lightest = (readings: ReadonlyArray<AccountReading>) =>
  readings
    .filter((reading) => !reading.limited)
    .toSorted(
      (left, right) =>
        accountLoad(left) - accountLoad(right) || left.instanceId.localeCompare(right.instanceId),
    )[0];

export function chooseNewThreadAccount(
  readings: ReadonlyArray<AccountReading>,
  preferred: ProviderInstanceId | null,
): ProviderInstanceId | undefined {
  const pinned = readings.find((reading) => reading.instanceId === preferred);
  if (pinned !== undefined && !pinned.limited) return pinned.instanceId;
  return lightest(readings)?.instanceId;
}

export function chooseMoveTarget(
  current: AccountReading,
  readings: ReadonlyArray<AccountReading>,
): MoveDecision | undefined {
  const best = lightest(readings.filter((reading) => reading.instanceId !== current.instanceId));
  if (best === undefined) return undefined;
  if (current.limited) return { instanceId: best.instanceId, reason: "limited" };
  if ((current.weekly ?? 0) - (best.weekly ?? 0) >= AHEAD_POINTS) {
    return { instanceId: best.instanceId, reason: "ahead" };
  }
  return undefined;
}

export interface ClaudeAccountMoveInput {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly fromInstanceId: ProviderInstanceId | null;
  readonly toInstanceId: ProviderInstanceId;
  readonly reason: ClaudeAccountMoveReason;
}

/**
 * Places new Claude threads on the account with the most room and picks a new
 * account for a thread whose account is limited or far ahead on weekly use.
 * The default never moves anything, so tests and callers without the
 * production layer keep the requested account.
 */
export class ClaudeAccountBalancer extends Context.Reference<{
  readonly enabled: Effect.Effect<boolean>;
  /** Undefined when balancing is off or the requested account has no partner to balance with. */
  readonly placeNewThread: (input: {
    readonly projectId: ProjectId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderInstanceId | undefined>;
  readonly chooseMove: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<MoveDecision | undefined>;
  readonly noteLimited: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly resetAt: string;
  }) => Effect.Effect<void>;
  readonly recordMove: (move: ClaudeAccountMoveInput) => Effect.Effect<void>;
  readonly refreshStaleReadings: Effect.Effect<void>;
  readonly getStatus: Effect.Effect<ClaudeBalancingStatus>;
}>("t3/provider/ClaudeAccountBalancer", {
  defaultValue: () => ({
    enabled: Effect.succeed(false),
    placeNewThread: () => Effect.succeed(undefined),
    chooseMove: () => Effect.succeed(undefined),
    noteLimited: () => Effect.void,
    recordMove: () => Effect.void,
    refreshStaleReadings: Effect.void,
    getStatus: Effect.succeed({ accounts: [], moves: [] }),
  }),
}) {}

type Balancer = Context.Service.Shape<typeof ClaudeAccountBalancer>;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const scope = yield* Effect.scope;
  const limitedUntil = yield* Ref.make(new Map<ProviderInstanceId, number>());
  const refreshRequestedAt = yield* Ref.make(new Map<ProviderInstanceId, number>());

  // Fork-only table: a numbered migration would collide with upstream's next one on rebase.
  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_desk_claude_account_moves (
      move_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      thread_title TEXT NOT NULL,
      from_instance_id TEXT,
      to_instance_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.pipe(Effect.orDie);

  const readSettings = settingsService.getSettings.pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );

  const readGroup = Effect.fn("ClaudeAccountBalancer.readGroup")(function* (
    settings: ServerSettings,
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
  ) {
    const providers = yield* registry.getProviders;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const until = yield* Ref.get(limitedUntil);
    return balancingGroup(providers, instanceId)
      .filter(
        (provider) =>
          provider.instanceId === instanceId ||
          resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId),
      )
      .map((provider) => accountReading(provider, until.get(provider.instanceId), nowMs));
  });

  const placeNewThread: Balancer["placeNewThread"] = Effect.fn(
    "ClaudeAccountBalancer.placeNewThread",
  )(function* (input) {
    const settings = yield* readSettings;
    if (settings === undefined || !settings.claudeBalancing.enabled) return undefined;
    const group = yield* readGroup(settings, input.projectId, input.modelSelection.instanceId);
    if (group.length < 2) return undefined;
    return chooseNewThreadAccount(group, settings.claudeBalancing.newThreadsInstanceId);
  });

  const chooseMove: Balancer["chooseMove"] = Effect.fn("ClaudeAccountBalancer.chooseMove")(
    function* (input) {
      const settings = yield* readSettings;
      if (settings === undefined || !settings.claudeBalancing.enabled) return undefined;
      const group = yield* readGroup(settings, input.projectId, input.instanceId);
      const current = group.find((reading) => reading.instanceId === input.instanceId);
      return current === undefined ? undefined : chooseMoveTarget(current, group);
    },
  );

  const noteLimited: Balancer["noteLimited"] = (input) => {
    const resetMs = Date.parse(input.resetAt);
    if (!Number.isFinite(resetMs)) return Effect.void;
    return Ref.update(limitedUntil, (current) =>
      (current.get(input.instanceId) ?? 0) >= resetMs
        ? current
        : new Map(current).set(input.instanceId, resetMs),
    );
  };

  const recordMove: Balancer["recordMove"] = Effect.fn("ClaudeAccountBalancer.recordMove")(
    function* (move) {
      const at = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
      INSERT OR IGNORE INTO agent_desk_claude_account_moves
        (move_id, thread_id, thread_title, from_instance_id, to_instance_id, reason, created_at)
      VALUES (${move.id}, ${move.threadId}, ${move.threadTitle}, ${move.fromInstanceId},
        ${move.toInstanceId}, ${move.reason}, ${at})
    `;
      yield* sql`
      DELETE FROM agent_desk_claude_account_moves WHERE move_id NOT IN (
        SELECT move_id FROM agent_desk_claude_account_moves
        ORDER BY created_at DESC, move_id DESC LIMIT ${KEPT_MOVES}
      )
    `;
      yield* Effect.logInfo("claude-balancing.move", {
        threadId: move.threadId,
        from: move.fromInstanceId,
        to: move.toInstanceId,
        reason: move.reason,
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("claude-balancing.record-move-failed", { cause }),
    ),
  );

  // Usage only refreshes while a client is connected, so balancing refreshes
  // its own accounts. A refresh spawns a Claude probe; once per account per
  // window is enough, and it never delays a decision.
  const refreshStaleReadings: Balancer["refreshStaleReadings"] = Effect.gen(function* () {
    const settings = yield* readSettings;
    if (settings === undefined || !settings.claudeBalancing.enabled) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const providers = yield* registry.getProviders;
    const requested = yield* Ref.get(refreshRequestedAt);
    const stale = providers.filter(
      (provider) =>
        usable(provider) &&
        nowMs - (Date.parse(provider.usageLimits?.checkedAt ?? "") || 0) >= STALE_READING_MS &&
        nowMs - (requested.get(provider.instanceId) ?? 0) >= STALE_READING_MS,
    );
    if (stale.length === 0) return;
    yield* Ref.update(refreshRequestedAt, (current) => {
      const next = new Map(current);
      for (const provider of stale) next.set(provider.instanceId, nowMs);
      return next;
    });
    yield* Effect.forEach(stale, (provider) => registry.refreshInstance(provider.instanceId), {
      discard: true,
    }).pipe(Effect.forkIn(scope));
  });

  const readMoves = sql<{
    readonly move_id: string;
    readonly thread_id: string;
    readonly thread_title: string;
    readonly from_instance_id: string | null;
    readonly to_instance_id: string;
    readonly reason: ClaudeAccountMoveReason;
    readonly created_at: string;
  }>`
    SELECT move_id, thread_id, thread_title, from_instance_id, to_instance_id, reason, created_at
    FROM agent_desk_claude_account_moves
    ORDER BY created_at DESC, move_id DESC
    LIMIT ${LISTED_MOVES}
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): ClaudeAccountMove => ({
        id: row.move_id,
        threadId: ThreadId.make(row.thread_id),
        threadTitle: row.thread_title,
        fromInstanceId:
          row.from_instance_id === null ? null : ProviderInstanceId.make(row.from_instance_id),
        toInstanceId: ProviderInstanceId.make(row.to_instance_id),
        reason: row.reason,
        at: row.created_at,
      })),
    ),
  );

  const readThreadCounts = sql<{
    readonly provider_instance_id: string | null;
    readonly thread_count: number;
  }>`
    SELECT provider_instance_id, COUNT(*) AS thread_count
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL AND json_extract(payload_json, '$.archivedAt') IS NULL
    GROUP BY provider_instance_id
  `.pipe(
    Effect.map(
      (rows) => new Map(rows.map((row) => [row.provider_instance_id, row.thread_count] as const)),
    ),
  );

  const getStatus: Balancer["getStatus"] = Effect.gen(function* () {
    yield* refreshStaleReadings;
    const providers = (yield* registry.getProviders).filter(
      (provider) => provider.driver === CLAUDE_DRIVER,
    );
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const until = yield* Ref.get(limitedUntil);
    const threadCounts = yield* readThreadCounts;
    const accounts = providers.map((provider): ClaudeAccountStatus => {
      const reading = accountReading(provider, until.get(provider.instanceId), nowMs);
      return {
        instanceId: provider.instanceId,
        ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
        ...(provider.auth.email === undefined ? {} : { email: provider.auth.email }),
        enabled: provider.enabled,
        balanced: balancingGroup(providers, provider.instanceId).length > 1,
        limited: reading.limited,
        fiveHour: activeWindow(provider, "five_hour", nowMs),
        weekly: activeWindow(provider, "seven_day", nowMs),
        checkedAt: provider.usageLimits?.checkedAt ?? null,
        threadCount: threadCounts.get(provider.instanceId) ?? 0,
      };
    });
    return { accounts, moves: yield* readMoves };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("claude-balancing.status-failed", { cause }).pipe(
        Effect.as({ accounts: [], moves: [] }),
      ),
    ),
    Effect.withSpan("ClaudeAccountBalancer.getStatus"),
  );

  return {
    enabled: readSettings.pipe(
      Effect.map((settings) => settings?.claudeBalancing.enabled === true),
    ),
    placeNewThread,
    chooseMove,
    noteLimited,
    recordMove,
    refreshStaleReadings,
    getStatus,
  } satisfies Balancer;
});

export const layer = Layer.effect(ClaudeAccountBalancer, make);
