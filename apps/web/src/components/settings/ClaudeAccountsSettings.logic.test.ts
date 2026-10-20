import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeAccountMove } from "./ClaudeAccountsSettings.logic";

const names: Record<string, string> = { claude_a: "Account A", claude_b: "Account B" };
const accountName = (instanceId: ProviderInstanceId) => names[instanceId] ?? instanceId;
const a = ProviderInstanceId.make("claude_a");
const b = ProviderInstanceId.make("claude_b");

describe("describeAccountMove", () => {
  it("says why each thread moved", () => {
    expect(
      describeAccountMove(
        { threadTitle: "pixar-fresh", fromInstanceId: null, toInstanceId: b, reason: "new_thread" },
        accountName,
      ),
    ).toBe("pixar-fresh started on Account B.");
    expect(
      describeAccountMove(
        { threadTitle: "shot-based", fromInstanceId: a, toInstanceId: b, reason: "limited" },
        accountName,
      ),
    ).toBe("shot-based moved to Account B: Account A hit a usage limit.");
    expect(
      describeAccountMove(
        { threadTitle: " ", fromInstanceId: a, toInstanceId: b, reason: "ahead" },
        accountName,
      ),
    ).toBe(
      "Untitled thread moved to Account B: Account A was 25 or more points ahead on weekly use.",
    );
  });
});
