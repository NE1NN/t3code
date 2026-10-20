import { useAtomValue } from "@effect/atom-react";
import type { OrchestrationV2DecisionMedia } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, InboxIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { isElectron } from "~/env";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import {
  isBlocking,
  isIrreversible,
  useDecisionQueue,
  type DecisionEntry,
} from "~/state/decisions";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type DecisionFilter = "all" | "blocking" | "irreversible";

const FILTERS: ReadonlyArray<{
  readonly value: DecisionFilter;
  readonly label: string;
  readonly matches: (item: DecisionEntry) => boolean;
}> = [
  { value: "all", label: "All", matches: () => true },
  { value: "blocking", label: "Blocking", matches: isBlocking },
  { value: "irreversible", label: "Can't undo", matches: isIrreversible },
];

const decisionKey = (item: DecisionEntry) => `${item.environmentId}:${item.requestId}`;

export function DecisionsPage({
  selectedKey,
  onSelect,
}: {
  readonly selectedKey: string | undefined;
  readonly onSelect: (key: string | undefined) => void;
}) {
  const queue = useDecisionQueue();
  const [filter, setFilter] = useState<DecisionFilter>("all");
  const matches = FILTERS.find((entry) => entry.value === filter)?.matches ?? (() => true);
  const shown = queue.items.filter(matches);
  const explicit = queue.items.find((item) => decisionKey(item) === selectedKey);
  const current = explicit ?? shown[0] ?? null;
  const blockingCount = queue.items.filter(isBlocking).length;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-3">
            <h1 className="text-sm font-medium">Decisions</h1>
            <span className="truncate text-muted-foreground text-xs">
              {queue.items.length} waiting · {blockingCount} blocking an agent · answered today{" "}
              {queue.answeredCount}
            </span>
          </div>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1">
          <section
            aria-label="Queue"
            className={cn(
              "min-h-0 w-full flex-col gap-2 overflow-y-auto border-border/60 px-4 pt-1 pb-6 md:flex md:w-88 md:shrink-0 md:border-r",
              explicit ? "hidden" : "flex",
            )}
          >
            <ToggleGroup
              aria-label="Filter decisions"
              value={[filter]}
              onValueChange={(value) => {
                const next = value[0];
                if (next) setFilter(next as DecisionFilter);
              }}
            >
              {FILTERS.map((entry) => (
                <Toggle key={entry.value} value={entry.value}>
                  {entry.label} {queue.items.filter(entry.matches).length}
                </Toggle>
              ))}
            </ToggleGroup>
            {shown.map((item) => (
              <DecisionQueueRow
                key={decisionKey(item)}
                item={item}
                selected={current !== null && decisionKey(current) === decisionKey(item)}
                onSelect={() => onSelect(decisionKey(item))}
              />
            ))}
            {queue.loading && queue.items.length === 0 ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : shown.length === 0 ? (
              <p
                className={cn(
                  "rounded-lg border border-dashed px-4 py-7 text-center text-muted-foreground text-sm",
                  queue.items.length === 0 && "md:hidden",
                )}
              >
                Nothing waiting on you.
              </p>
            ) : null}
          </section>
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-1 pb-8 md:block md:px-8",
              explicit ? "block" : "hidden",
            )}
          >
            {current ? (
              <DecisionDetail
                key={decisionKey(current)}
                item={current}
                onBack={() => onSelect(undefined)}
              />
            ) : (
              <Empty className="h-full">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <InboxIcon />
                  </EmptyMedia>
                  <EmptyTitle>No open decisions</EmptyTitle>
                  <EmptyDescription>
                    When an agent needs you to choose, it shows up here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function DecisionQueueRow({
  item,
  selected,
  onSelect,
}: {
  readonly item: DecisionEntry;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const nowMinute = useNowMinute();
  const videoCount = item.decision?.media.filter((media) =>
    media.mimeType.startsWith("video/"),
  ).length;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full flex-col items-stretch gap-1.5 rounded-lg border bg-card px-3.5 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected ? "border-primary ring-3 ring-primary/12" : "hover:bg-accent/40",
      )}
    >
      {isBlocking(item) || isIrreversible(item) || (videoCount ?? 0) > 0 ? (
        <span className="flex flex-wrap gap-1.5">
          {isBlocking(item) ? <Badge variant="warning">Blocking</Badge> : null}
          {isIrreversible(item) ? <Badge variant="error">Can't undo</Badge> : null}
          {videoCount ? (
            <Badge variant="outline">
              {videoCount} {videoCount === 1 ? "video" : "videos"}
            </Badge>
          ) : null}
        </span>
      ) : null}
      <span className="font-medium text-sm">{item.questions[0]?.question ?? "Question"}</span>
      <span className="flex justify-between gap-2 text-muted-foreground text-xs">
        <span className="min-w-0 truncate">
          {item.threadTitle} · {item.projectTitle}
        </span>
        <span className="shrink-0">{relativeAge(item.createdAt, nowMinute)}</span>
      </span>
    </button>
  );
}

function relativeAge(createdAt: string, nowMinute: string) {
  return formatRelativeTimeLabel(createdAt, Math.max(Date.parse(`${nowMinute}Z`), Date.now()));
}

function DecisionDetail({
  item,
  onBack,
}: {
  readonly item: DecisionEntry;
  readonly onBack: () => void;
}) {
  const navigate = useNavigate();
  const nowMinute = useNowMinute();
  const decision = item.decision;
  const question = item.questions[0];
  const answerable =
    question !== undefined && item.questions.length === 1 && question.multiSelect !== true;
  const options = question?.options ?? [];
  const recommended =
    options.find((option) => option.label === decision?.recommendedOption) ?? options[0];
  // Follows the agent's recommendation, which can change mid-discussion, until the user picks.
  const [userPick, setPicked] = useState<string | null>(null);
  const picked = userPick ?? recommended?.label ?? null;
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<"answer" | "ask" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const respond = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });
  const discuss = useOrchestrationCommand(threadEnvironment.discussDecision, {
    reportFailure: false,
  });
  const providers = useAtomValue(serverEnvironment.providersValueAtom(item.environmentId));
  const account =
    providers?.find((provider) => provider.instanceId === item.providerInstanceId)?.displayName ??
    item.providerInstanceId;
  const pickedOption = options.find((option) => option.label === picked);
  const pickByNumber = useEffectEvent((event: KeyboardEvent) => {
    if (!answerable || pending !== null || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const option = options[Number.parseInt(event.key, 10) - 1];
    if (!option) return;
    event.preventDefault();
    setPicked(option.label);
  });
  useEffect(() => {
    document.addEventListener("keydown", pickByNumber);
    return () => document.removeEventListener("keydown", pickByNumber);
  }, []);
  const customAnswer = draft.trim();
  const openThread = () =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: item.environmentId, threadId: item.threadId },
    });

  const run = async (kind: "answer" | "ask") => {
    if (!question) return;
    setPending(kind);
    setError(null);
    const result =
      kind === "ask"
        ? await discuss({
            environmentId: item.environmentId,
            input: { threadId: item.threadId, requestId: item.requestId, text: customAnswer },
          })
        : await respond({
            environmentId: item.environmentId,
            input: {
              threadId: item.threadId,
              requestId: item.requestId,
              answers: {
                [question.id]:
                  customAnswer || (pickedOption ? (pickedOption.value ?? pickedOption.label) : ""),
              },
            },
          });
    setPending(null);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "That did not go through. Try again.");
      return;
    }
    if (kind === "ask") setDraft("");
  };

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost-muted"
          size="compact"
          className="self-start md:hidden"
          onClick={onBack}
        >
          <ArrowLeftIcon />
          All decisions
        </Button>
        <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          <Badge variant="outline">{decision ? "Decision" : "Question"}</Badge>
          {isBlocking(item) ? <Badge variant="warning">Blocking</Badge> : null}
          {decision ? (
            decision.reversible ? (
              <Badge variant="outline">Can be changed later</Badge>
            ) : (
              <Badge variant="error">Can't be undone</Badge>
            )
          ) : null}
          <span>from</span>
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: item.environmentId, threadId: item.threadId }}
            className="text-foreground underline underline-offset-2"
          >
            {item.threadTitle}
          </Link>
          <span>
            · {account} · {relativeAge(item.createdAt, nowMinute)}
          </span>
        </div>
        <h2 className="font-semibold text-xl tracking-tight">{question?.question ?? "Question"}</h2>
        {decision ? (
          <p className="max-w-[70ch] whitespace-pre-wrap text-foreground/85 text-sm">
            {decision.context}
          </p>
        ) : null}
      </div>

      {decision && decision.media.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3.5">
          {decision.media.map((media) => (
            <DecisionMediaCard key={media.attachmentId} item={item} media={media} />
          ))}
        </div>
      ) : null}

      {answerable ? (
        <div className="flex flex-col gap-0.5 rounded-xl border bg-card px-2.5 pt-3 pb-2">
          <div className="px-2.5 text-muted-foreground text-xs">{question.header}</div>
          <div role="radiogroup" aria-label={question.question} className="mt-1 flex flex-col">
            {options.map((option, index) => {
              const isPicked = option.label === picked && customAnswer.length === 0;
              return (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={isPicked}
                  disabled={pending !== null}
                  onClick={() => setPicked(option.label)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-primary/25 focus-visible:ring-inset",
                    isPicked ? "bg-muted/55" : "hover:bg-muted/30",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium text-sm">
                      {option.label}
                      {option.label === decision?.recommendedOption ? (
                        <span className="font-normal text-muted-foreground"> (Recommended)</span>
                      ) : null}
                    </span>
                    {option.description !== option.label ? (
                      <span className="text-2xs text-secondary-label">{option.description}</span>
                    ) : null}
                  </span>
                  {isPicked ? (
                    <CheckIcon className="size-3.5 shrink-0 text-primary" />
                  ) : (
                    <kbd className="flex size-5 shrink-0 items-center justify-center font-medium text-3xs text-muted-foreground tabular-nums">
                      {index + 1}
                    </kbd>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
          {item.questions.map((entry) => (
            <p key={entry.id}>{entry.question}</p>
          ))}
          <p className="text-muted-foreground text-xs">Answer this one in its thread.</p>
        </div>
      )}

      {decision && decision.messages.length > 0 ? (
        <div className="flex flex-col gap-3">
          {decision.messages.map((message) =>
            message.author === "user" ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2.5 text-sm">
                  {message.text}
                </div>
              </div>
            ) : (
              <div key={message.id} className="max-w-[90%] text-sm">
                <div className="mb-0.5 font-semibold text-xs">{item.threadTitle}</div>
                <div className="whitespace-pre-wrap">{message.text}</div>
              </div>
            ),
          )}
          {!decision.agentWaiting && decision.messages.at(-1)?.author === "user" ? (
            <p className="text-muted-foreground text-xs">
              Sent to the agent. Its reply shows here.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5 rounded-2xl border bg-card px-4 pt-3 pb-2.5 shadow-xs/5">
        <Textarea
          aria-label="Your answer or a message to the agent"
          placeholder={
            answerable
              ? "Type your own answer, or leave this blank to use the selected option"
              : "Write a message to the agent"
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          unstyled
          rows={2}
        />
        {error ? <p className="text-destructive-foreground text-xs">{error}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3 text-muted-foreground text-xs">
            <span>{account}</span>
            <span aria-hidden className="text-border">
              |
            </span>
            <Button variant="link" size="compact" onClick={openThread}>
              Open thread
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {decision ? (
              <Button
                variant="outline"
                disabled={pending !== null || customAnswer.length === 0}
                onClick={() => void run("ask")}
              >
                {pending === "ask" ? <Spinner /> : null}
                Ask agent
              </Button>
            ) : null}
            {answerable ? (
              <Button
                disabled={pending !== null || (customAnswer.length === 0 && !pickedOption)}
                onClick={() => void run("answer")}
              >
                {pending === "answer" ? <Spinner /> : null}
                {customAnswer.length > 0
                  ? "Submit answer"
                  : `Submit · ${pickedOption?.label ?? ""}`}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

function DecisionMediaCard({
  item,
  media,
}: {
  readonly item: DecisionEntry;
  readonly media: OrchestrationV2DecisionMedia;
}) {
  const asset = useAssetUrlState(item.environmentId, {
    _tag: "attachment",
    attachmentId: media.attachmentId,
    fileName: media.name,
    mimeType: media.mimeType,
    disposition: "inline",
  });
  const label = media.label ?? media.name;
  const verdict = media.caption?.startsWith("Passes")
    ? "pass"
    : media.caption?.startsWith("Fails")
      ? "fail"
      : null;
  const url = asset._tag === "Success" ? asset.url : null;
  return (
    <figure className="flex flex-col gap-2 rounded-xl border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-semibold text-sm">{label}</span>
        {verdict === "pass" ? (
          <Badge variant="success">Passes</Badge>
        ) : verdict === "fail" ? (
          <Badge variant="error">Fails</Badge>
        ) : null}
      </div>
      {url === null ? (
        <div className="flex aspect-[9/16] max-h-110 items-center justify-center rounded-lg bg-muted">
          {asset._tag === "Failure" ? (
            <span className="text-muted-foreground text-xs">Could not load {media.name}</span>
          ) : (
            <Spinner />
          )}
        </div>
      ) : media.mimeType.startsWith("video/") ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={url}
          aria-label={label}
          className="aspect-[9/16] max-h-110 w-full rounded-lg bg-black object-contain"
        />
      ) : media.mimeType.startsWith("image/") ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={label} className="max-h-110 w-full rounded-lg object-contain" />
        </a>
      ) : media.mimeType.startsWith("audio/") ? (
        <audio controls preload="metadata" src={url} aria-label={label} className="w-full" />
      ) : (
        <a href={url} target="_blank" rel="noreferrer" className="text-sm underline">
          Open {media.name}
        </a>
      )}
      {media.caption ? (
        <figcaption
          className={cn(
            "text-xs",
            verdict === "pass"
              ? "text-success-foreground"
              : verdict === "fail"
                ? "text-destructive-foreground"
                : "text-muted-foreground",
          )}
        >
          {media.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
