import type { ClaudeAccountMove, ProviderInstanceId } from "@t3tools/contracts";

export function describeAccountMove(
  move: Pick<ClaudeAccountMove, "threadTitle" | "fromInstanceId" | "toInstanceId" | "reason">,
  accountName: (instanceId: ProviderInstanceId) => string,
): string {
  const title = move.threadTitle.trim() || "Untitled thread";
  const to = accountName(move.toInstanceId);
  const from = move.fromInstanceId === null ? null : accountName(move.fromInstanceId);
  switch (move.reason) {
    case "new_thread":
      return `${title} started on ${to}.`;
    case "limited":
      return `${title} moved to ${to}: ${from ?? "its account"} hit a usage limit.`;
    case "ahead":
      return `${title} moved to ${to}: ${from ?? "its account"} was 25 or more points ahead on weekly use.`;
  }
}
