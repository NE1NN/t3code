import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "./baseSchemas.ts";
import { OrchestrationV2Decision, OrchestrationV2UserInputQuestion } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * One open question from any thread. Questions asked through
 * `request_decision` carry `decision`; native provider questions do not.
 */
export const DecisionQueueItem = Schema.Struct({
  threadId: ThreadId,
  threadTitle: Schema.String,
  projectId: ProjectId,
  projectTitle: Schema.String,
  providerInstanceId: ProviderInstanceId,
  requestId: RuntimeRequestId,
  turnItemId: TurnItemId,
  createdAt: IsoDateTime,
  questions: Schema.Array(OrchestrationV2UserInputQuestion),
  decision: Schema.optional(OrchestrationV2Decision),
});
export type DecisionQueueItem = typeof DecisionQueueItem.Type;

export const DecisionQueueInput = Schema.Struct({
  /** Start of the reader's day, for the "answered today" count. */
  answeredSince: IsoDateTime,
});
export type DecisionQueueInput = typeof DecisionQueueInput.Type;

export const DecisionQueue = Schema.Struct({
  items: Schema.Array(DecisionQueueItem),
  answeredCount: NonNegativeInt,
});
export type DecisionQueue = typeof DecisionQueue.Type;

export class DecisionQueueError extends Schema.TaggedError<DecisionQueueError>()(
  "DecisionQueueError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Could not read open decisions.";
  }
}
