import { useAtomValue } from "@effect/atom-react";
import type { DecisionQueueItem, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useNowMinute } from "../hooks/useNowMinute";
import { useConnectedEnvironmentIds } from "./environments";
import { serverEnvironment } from "./server";

export interface DecisionEntry extends DecisionQueueItem {
  readonly environmentId: EnvironmentId;
}

export interface DecisionQueueView {
  readonly items: ReadonlyArray<DecisionEntry>;
  readonly answeredCount: number;
  readonly loading: boolean;
}

const EMPTY_QUEUE: DecisionQueueView = { items: [], answeredCount: 0, loading: false };

/** Blocking decisions first, then oldest first: the queue is worked from the top. */
export function sortDecisions(items: ReadonlyArray<DecisionEntry>): DecisionEntry[] {
  return items.toSorted((left, right) => {
    const blocking = Number(isBlocking(right)) - Number(isBlocking(left));
    return blocking !== 0 ? blocking : left.createdAt.localeCompare(right.createdAt);
  });
}

export const isBlocking = (item: DecisionQueueItem) => item.decision?.agentWaiting === true;
export const isIrreversible = (item: DecisionQueueItem) => item.decision?.reversible === false;

// Keyed by the start of the reader's day and the servers it reads, one subscription per server.
const decisionQueueAtom = Atom.family((key: string) => {
  const [answeredSince = "", ...environmentIds] = key.split("\n") as [string, ...EnvironmentId[]];
  return Atom.make((get): DecisionQueueView => {
    if (environmentIds.length === 0) return EMPTY_QUEUE;
    const items: DecisionEntry[] = [];
    let answeredCount = 0;
    let loading = false;
    for (const environmentId of environmentIds) {
      const result = get(
        serverEnvironment.decisionsLive({ environmentId, input: { answeredSince } }),
      );
      const queue = Option.getOrNull(AsyncResult.value(result));
      if (queue === null) {
        loading ||= result._tag === "Initial";
        continue;
      }
      answeredCount += queue.answeredCount;
      for (const item of queue.items) items.push({ ...item, environmentId });
    }
    return { items: sortDecisions(items), answeredCount, loading };
  }).pipe(Atom.withLabel(`web-decision-queue:${key}`));
});

const threadDecisionAtom = Atom.family((key: string) => {
  const separator = key.lastIndexOf("\t");
  const queueKey = key.slice(0, separator);
  const threadKey = key.slice(separator + 1);
  return Atom.make((get) =>
    get(decisionQueueAtom(queueKey)).items.some(
      (item) => `${item.environmentId}:${item.threadId}` === threadKey,
    ),
  ).pipe(Atom.withLabel(`web-thread-decision:${key}`));
});

function startOfLocalDay(nowMinute: string): string {
  const date = new Date(`${nowMinute}:00.000Z`);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

function useDecisionQueueKey(): string {
  const answeredSince = startOfLocalDay(useNowMinute());
  return [answeredSince, ...useConnectedEnvironmentIds()].join("\n");
}

export function useDecisionQueue(): DecisionQueueView {
  return useAtomValue(decisionQueueAtom(useDecisionQueueKey()));
}

export function useThreadHasOpenDecision(environmentId: EnvironmentId, threadId: ThreadId) {
  return useAtomValue(threadDecisionAtom(`${useDecisionQueueKey()}\t${environmentId}:${threadId}`));
}
