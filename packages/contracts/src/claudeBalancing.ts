import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** A null target means each new thread starts on the account with the most room left. */
export const ClaudeBalancingSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  newThreadsInstanceId: Schema.NullOr(ProviderInstanceId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type ClaudeBalancingSettings = typeof ClaudeBalancingSettings.Type;

export const ClaudeAccountMoveReason = Schema.Literals(["new_thread", "limited", "ahead"]);
export type ClaudeAccountMoveReason = typeof ClaudeAccountMoveReason.Type;

export const ClaudeAccountMove = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  threadTitle: Schema.String,
  fromInstanceId: Schema.NullOr(ProviderInstanceId),
  toInstanceId: ProviderInstanceId,
  reason: ClaudeAccountMoveReason,
  at: IsoDateTime,
});
export type ClaudeAccountMove = typeof ClaudeAccountMove.Type;

export const ClaudeAccountUsageWindow = Schema.Struct({
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(IsoDateTime),
});
export type ClaudeAccountUsageWindow = typeof ClaudeAccountUsageWindow.Type;

export const ClaudeAccountStatus = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  /** Shares native history with another account, so threads can move between them. */
  balanced: Schema.Boolean,
  limited: Schema.Boolean,
  fiveHour: Schema.NullOr(ClaudeAccountUsageWindow),
  weekly: Schema.NullOr(ClaudeAccountUsageWindow),
  checkedAt: Schema.NullOr(IsoDateTime),
  threadCount: NonNegativeInt,
});
export type ClaudeAccountStatus = typeof ClaudeAccountStatus.Type;

export const ClaudeBalancingStatus = Schema.Struct({
  accounts: Schema.Array(ClaudeAccountStatus),
  moves: Schema.Array(ClaudeAccountMove),
});
export type ClaudeBalancingStatus = typeof ClaudeBalancingStatus.Type;
