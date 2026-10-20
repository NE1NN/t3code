import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DecisionToolkit } from "./tools.ts";

const toFailure = (error: DecisionService.DecisionError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "no_active_run"
        ? "parent_not_active"
        : error.reason === "storage" || error.reason === "orchestration"
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

const nextStep = (outcome: DecisionService.DecisionOutcome) => {
  switch (outcome.status) {
    case "posted":
      return "Posted to the user's Decisions queue. Keep working on what doesn't depend on it; the answer arrives later as a message that names this decision. Don't repeat the question in chat.";
    case "answered":
      return `The user chose: ${outcome.answer}. Carry on with that choice.`;
    case "user_message":
      return "The user wrote back instead of choosing. Answer with reply_to_decision (wait=true to keep waiting for their choice), changing the options if their message calls for it.";
    case "dismissed":
      return "The user dismissed this decision. Don't act on any of its options; stop and wait for instructions.";
    case "no_answer_yet":
      return "No answer yet. The decision stays in the user's queue and the answer will arrive as a message. End your turn now with a one-line status, unless there is other work that doesn't depend on it.";
  }
};

const toResult = (outcome: DecisionService.DecisionOutcome) => ({
  decisionId: outcome.decisionId,
  status: outcome.status,
  ...(outcome.status === "answered" ? { answer: outcome.answer } : {}),
  ...(outcome.status === "user_message" ? { message: outcome.message } : {}),
  next: nextStep(outcome),
});

const caller = Effect.fn("DecisionTools.caller")(function* (operation: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
  return { threadId: thread.threadId, providerInstanceId: thread.providerInstanceId };
});

// Asking the user changes nothing in the workspace, so plan mode and read-only sandboxes keep it.
const handlers = {
  request_decision: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const decisions = yield* DecisionService.DecisionService;
      const outcome = yield* decisions
        .request(yield* caller("request_decision"), {
          title: input.title,
          context: input.context,
          options: input.options,
          recommendedOption: input.recommended,
          reversible: input.reversible,
          blocking: input.blocking,
          media: input.media ?? [],
          waitMinutes: input.waitMinutes,
        })
        .pipe(Effect.mapError(toFailure));
      return toResult(outcome);
    }),
  ),
  reply_to_decision: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const decisions = yield* DecisionService.DecisionService;
      const outcome = yield* decisions
        .reply(yield* caller("reply_to_decision"), {
          decisionId: input.decisionId,
          message: input.message,
          options: input.options,
          recommendedOption: input.recommended,
          media: input.media,
          wait: input.wait,
          waitMinutes: input.waitMinutes,
        })
        .pipe(Effect.mapError(toFailure));
      return toResult(outcome);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof DecisionToolkit.tools>;

export const layer = McpToolAccess.toLayer(DecisionToolkit, handlers);
