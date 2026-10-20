import { OrchestratorMcpFailure, RuntimeRequestId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as DecisionService from "../../../decisions/DecisionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const BoundedText = (max: number, description: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max)).annotate({ description });

const Options = Schema.Array(
  Schema.Struct({
    label: BoundedText(80, "Short name for the choice."),
    description: BoundedText(400, "One sentence on what happens if the user picks it."),
  }),
).check(Schema.isMinLength(2), Schema.isMaxLength(4));

const Recommended = Schema.String.annotate({
  description: "The label of the option you recommend. It is preselected for the user.",
});

const WaitMinutes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(60),
).annotate({
  description: "How long to wait for the user before returning no_answer_yet. Defaults to 50.",
});

const DecisionResult = Schema.Struct({
  decisionId: RuntimeRequestId,
  status: Schema.Literals(["posted", "answered", "user_message", "dismissed", "no_answer_yet"]),
  answer: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  next: Schema.String,
});

const dependencies = [McpInvocationContext.McpInvocationContext, DecisionService.DecisionService];

const RequestDecisionTool = Tool.make("request_decision", {
  description:
    "Ask the user to decide something through their Decisions queue instead of asking in chat. Use it when you need the user to choose between approaches, approve something hard to undo, or judge results such as renders. Give 2-4 options with your recommendation, the evidence as media (videos play with sound) with a one-line caption each, and say whether the choice can be undone and whether you are blocked. With blocking=true the call waits until the user picks an option or writes back; with blocking=false it returns at once and the answer arrives later as a message naming this decision.",
  parameters: Schema.Struct({
    title: BoundedText(160, "The question in one short line."),
    context: BoundedText(4000, "What the user needs to know to decide, in a few plain sentences."),
    options: Options,
    recommended: Schema.optional(Recommended),
    reversible: Schema.Boolean.annotate({
      description: "Whether the choice can be undone later.",
    }),
    blocking: Schema.Boolean.annotate({
      description:
        "True when you cannot continue without the answer: the call waits for it. False when you can keep working on something else.",
    }),
    media: Schema.optional(
      Schema.Array(
        Schema.Struct({
          path: BoundedText(4096, "Absolute path to a video, image, audio file or pdf."),
          label: Schema.optional(BoundedText(120, "Short name, e.g. '30s render, take 2'.")),
          caption: Schema.optional(
            BoundedText(
              300,
              "One line on what passes or fails, e.g. 'Fails: logo at 0:12 is cropped'.",
            ),
          ),
        }),
      ).check(Schema.isMaxLength(8)),
    ),
    waitMinutes: Schema.optional(WaitMinutes),
  }),
  success: DecisionResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask the user to decide")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ReplyToDecisionTool = Tool.make("reply_to_decision", {
  description:
    "Answer the user's message on one of your open decisions, and optionally replace its options or recommendation. With wait=true the call then waits for the user's choice or next message, as request_decision does.",
  parameters: Schema.Struct({
    decisionId: RuntimeRequestId,
    message: BoundedText(4000, "Your reply to the user, in plain sentences."),
    options: Schema.optional(Options),
    recommended: Schema.optional(Recommended),
    wait: Schema.Boolean.annotate({
      description: "True to wait for the user's choice or next message before returning.",
    }),
    waitMinutes: Schema.optional(WaitMinutes),
  }),
  success: DecisionResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Reply on a decision")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const DecisionToolkit = Toolkit.make(RequestDecisionTool, ReplyToDecisionTool);
