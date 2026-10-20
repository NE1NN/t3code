import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountLoad,
  accountReading,
  balancingGroup,
  chooseMoveTarget,
  chooseNewThreadAccount,
} from "./ClaudeAccountBalancer.ts";

const now = Date.parse("2026-10-21T00:00:00.000Z");
const later = "2026-10-22T00:00:00.000Z";
const earlier = "2026-10-20T00:00:00.000Z";

const claude = (
  id: string,
  usage: { readonly fiveHour?: number; readonly weekly?: number; readonly resetsAt?: string },
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("claudeAgent"),
  continuation: { groupKey: "claude:home:/home/me/.claude" },
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: earlier,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: earlier,
    windows: [
      ...(usage.fiveHour === undefined
        ? []
        : [
            {
              id: "five_hour",
              kind: "session" as const,
              label: "5-hour",
              usedPercent: usage.fiveHour,
              resetsAt: usage.resetsAt ?? later,
            },
          ]),
      ...(usage.weekly === undefined
        ? []
        : [
            {
              id: "seven_day",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: usage.weekly,
              resetsAt: later,
            },
          ]),
    ],
  },
  ...overrides,
});

const reading = (provider: ServerProvider, limitedUntil?: number) =>
  accountReading(provider, limitedUntil, now);

describe("accountReading", () => {
  it("loads an account by the fuller of its 5-hour and weekly windows", () => {
    expect(accountLoad(reading(claude("a", { fiveHour: 30, weekly: 70 })))).toBe(70);
    expect(accountLoad(reading(claude("a", { fiveHour: 90, weekly: 10 })))).toBe(90);
  });

  it("counts an account with no reading as unused", () => {
    const empty = reading(claude("a", {}, { usageLimits: undefined }));
    expect(accountLoad(empty)).toBe(0);
    expect(empty.limited).toBe(false);
  });

  it("treats a window whose reset has passed as empty", () => {
    const reset = reading(claude("a", { fiveHour: 100, resetsAt: earlier }));
    expect(reset.fiveHour).toBe(0);
    expect(reset.limited).toBe(false);
  });

  it("marks an account limited by a full window or a recent limit failure", () => {
    expect(reading(claude("a", { weekly: 100 })).limited).toBe(true);
    expect(reading(claude("a", { weekly: 20 }), Date.parse(later)).limited).toBe(true);
    expect(reading(claude("a", { weekly: 20 }), Date.parse(earlier)).limited).toBe(false);
  });
});

describe("balancingGroup", () => {
  it("groups enabled Claude accounts that share native history", () => {
    const providers = [
      claude("a", {}),
      claude("b", {}),
      claude("other-home", {}, { continuation: { groupKey: "claude:home:/elsewhere" } }),
      claude("off", {}, { enabled: false }),
      claude("logged-out", {}, { auth: { status: "unauthenticated" } }),
      claude("codex", {}, { driver: ProviderDriverKind.make("codex") }),
    ];
    expect(
      balancingGroup(providers, ProviderInstanceId.make("a")).map((p) => p.instanceId),
    ).toEqual(["a", "b"]);
    expect(balancingGroup(providers, ProviderInstanceId.make("codex"))).toEqual([]);
  });
});

describe("chooseNewThreadAccount", () => {
  const a = reading(claude("a", { fiveHour: 10, weekly: 60 }));
  const b = reading(claude("b", { fiveHour: 40, weekly: 20 }));

  it("starts on the account with the most room", () => {
    expect(chooseNewThreadAccount([a, b], null)).toBe("b");
  });

  it("keeps a chosen account unless it is limited", () => {
    expect(chooseNewThreadAccount([a, b], ProviderInstanceId.make("a"))).toBe("a");
    const limitedA = reading(claude("a", { weekly: 100 }));
    expect(chooseNewThreadAccount([limitedA, b], ProviderInstanceId.make("a"))).toBe("b");
  });

  it("has no answer when every account is limited", () => {
    const limitedA = reading(claude("a", { weekly: 100 }));
    const limitedB = reading(claude("b", { fiveHour: 100 }));
    expect(chooseNewThreadAccount([limitedA, limitedB], null)).toBeUndefined();
  });
});

describe("chooseMoveTarget", () => {
  it("moves off a limited account to one with room", () => {
    const current = reading(claude("a", { weekly: 100 }));
    const b = reading(claude("b", { weekly: 90 }));
    expect(chooseMoveTarget(current, [current, b])).toEqual({ instanceId: "b", reason: "limited" });
  });

  it("moves when the account runs 25 or more weekly points ahead", () => {
    const current = reading(claude("a", { weekly: 70 }));
    expect(chooseMoveTarget(current, [current, reading(claude("b", { weekly: 45 }))])).toEqual({
      instanceId: "b",
      reason: "ahead",
    });
    expect(
      chooseMoveTarget(current, [current, reading(claude("b", { weekly: 46 }))]),
    ).toBeUndefined();
  });

  it("stays when the other accounts are limited too", () => {
    const current = reading(claude("a", { weekly: 100 }));
    const b = reading(claude("b", { fiveHour: 100 }));
    expect(chooseMoveTarget(current, [current, b])).toBeUndefined();
  });
});
