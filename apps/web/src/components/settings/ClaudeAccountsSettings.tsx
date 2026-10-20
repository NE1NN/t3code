import {
  AuthProvidersManageScope,
  type ClaudeAccountStatus,
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
  usePrimarySettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { LimitWindows } from "../usage/UsageLimits";
import { describeAccountMove } from "./ClaudeAccountsSettings.logic";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const MOST_ROOM = "most_room";
const BALANCED_WINDOWS = new Set(["five_hour", "seven_day"]);

const accountLabel = (account: Pick<ClaudeAccountStatus, "displayName" | "instanceId">) =>
  account.displayName ?? account.instanceId;

export function ClaudeAccountsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const now = useRelativeTimeTick(30_000);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const balancing = useEnvironmentSettings(environmentId, (settings) => settings.claudeBalancing);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const status = useEnvironmentQuery(
    serverEnvironment.claudeBalancingStatus({ environmentId, input: {} }),
  );
  const [adding, setAdding] = useState(false);
  const accounts = status.data?.accounts ?? [];
  const providerById = new Map(providers.map((provider) => [provider.instanceId, provider]));
  const nameOf = (instanceId: ProviderInstanceId) => {
    const account = accounts.find((candidate) => candidate.instanceId === instanceId);
    return account ? accountLabel(account) : instanceId;
  };
  const balancedAccounts = accounts.filter((account) => account.enabled && account.balanced);
  const startOptions = [
    { value: MOST_ROOM, label: "Most room left" },
    ...balancedAccounts.map((account) => ({
      value: account.instanceId as string,
      label: accountLabel(account),
    })),
  ];

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("claude-accounts")}
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canManageProviders}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
            Add account
          </Button>
        }
      >
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Accounts that share one Claude config directory share thread history, so any of them can
          carry on any thread.
        </p>
        {accounts.length === 0 ? (
          <SettingsRow
            title={status.isPending ? "Loading accounts" : "No Claude accounts yet"}
            description="Add an account with a token from `claude setup-token`."
          />
        ) : (
          accounts.map((account) => (
            <AccountRow
              key={account.instanceId}
              account={account}
              provider={providerById.get(account.instanceId)}
              now={now}
              onEdit={() =>
                void navigate({
                  to: "/settings/providers",
                  search: { instanceId: account.instanceId },
                })
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Balancing">
        <SettingsRow
          {...searchableSetting("claude-balancing")}
          serverScoped
          settingKeys={["claudeBalancing"]}
          description="New threads start on the account with the most room left. A thread moves only when its account hits a limit, or runs 25 points ahead on weekly use."
          control={
            <Switch
              aria-label="Balance across accounts"
              checked={balancing.enabled}
              onCheckedChange={(enabled) => updateSettings({ claudeBalancing: { enabled } })}
            />
          }
        />
        <SettingsRow
          title="New threads start on"
          description="The composer still lets you pick an account for one thread."
          serverScoped
          settingKeys={["claudeBalancing"]}
          control={
            <Select
              items={startOptions}
              value={balancing.newThreadsInstanceId ?? MOST_ROOM}
              disabled={!balancing.enabled}
              onValueChange={(value) => {
                if (value === null) return;
                updateSettings({
                  claudeBalancing: {
                    newThreadsInstanceId:
                      value === MOST_ROOM ? null : ProviderInstanceId.make(value),
                  },
                });
              }}
            >
              <SelectTrigger size="xs" className="w-40" aria-label="New threads start on">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {startOptions.map(({ value, label }) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Recent moves">
        {(status.data?.moves ?? []).length === 0 ? (
          <SettingsRow title="No moves yet" />
        ) : (
          <ul className="flex flex-col px-3 py-2 sm:px-4">
            {(status.data?.moves ?? []).map((move) => (
              <li key={move.id} className="flex gap-2 py-1 text-xs">
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {formatDayAwareTimestamp(move.at, timestampFormat, now)}
                </span>
                <span className="min-w-0 text-foreground">{describeAccountMove(move, nameOf)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {adding ? (
        <AddClaudeAccountDialog
          environmentId={environmentId}
          onClose={() => {
            setAdding(false);
            status.refresh();
          }}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function AccountRow({
  account,
  provider,
  now,
  onEdit,
}: {
  readonly account: ClaudeAccountStatus;
  readonly provider: ServerProvider | undefined;
  readonly now: number;
  readonly onEdit: () => void;
}) {
  const windows = (provider?.usageLimits?.windows ?? []).filter((window) =>
    BALANCED_WINDOWS.has(window.id),
  );
  const login = account.email ?? provider?.auth.label ?? "Signed in";
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {accountLabel(account)}
          {!account.enabled ? (
            <Badge size="sm" variant="secondary">
              Off
            </Badge>
          ) : account.limited ? (
            <Badge size="sm" variant="warning">
              Limited
            </Badge>
          ) : account.balanced ? null : (
            <Badge size="sm" variant="outline">
              Separate history
            </Badge>
          )}
        </span>
      }
      description={`${login} · ${account.threadCount} ${account.threadCount === 1 ? "thread" : "threads"}`}
      control={
        <Button size="xs" variant="ghost-muted" onClick={onEdit}>
          Edit
        </Button>
      }
    >
      {windows.length > 0 ? (
        <div className="px-3 pb-3 sm:px-4">
          <LimitWindows driver={CLAUDE_DRIVER} windows={windows} now={now} compact />
        </div>
      ) : (
        <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">No usage reading yet.</p>
      )}
    </SettingsRow>
  );
}

function AddClaudeAccountDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const providerInstances = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances,
  );
  const persistInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = name.trim().length > 0 && token.trim().length > 0;

  // Threads only move between accounts that share a config directory.
  const sharedHomePath = Object.values(providerInstances).flatMap((instance) => {
    const config = instance.config as { readonly homePath?: unknown } | undefined;
    return instance.driver === CLAUDE_DRIVER &&
      typeof config?.homePath === "string" &&
      config.homePath.trim().length > 0
      ? [config.homePath]
      : [];
  })[0];

  const createAccount = async () => {
    if (pending || !ready || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    setPending(true);
    setError(null);
    const result = await persistInstance({
      operation: "create",
      instanceId: ProviderInstanceId.make(`claudeAgent_${randomUUID()}`),
      instance: {
        driver: CLAUDE_DRIVER,
        displayName: name.trim(),
        enabled: true,
        environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: token.trim(), sensitive: true }],
        config: {
          enabled: true,
          ...(sharedHomePath === undefined ? {} : { homePath: sharedHomePath }),
        },
      },
    });
    setPending(false);
    if (result._tag === "Success") onClose();
    else setError("Could not add the account. Check the connection and try again.");
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader
          title="Add Claude account"
          description="Sign in to the other account in a terminal, run `claude setup-token`, and paste the token here. It is stored as a secret on this machine."
        />
        <WizardPanel>
          <form
            id="add-claude-account"
            onSubmit={(event) => {
              event.preventDefault();
              void createAccount();
            }}
          >
            <SettingsRow
              title="Account name"
              description="Shown in the model picker and on this page."
              control={
                <Input
                  aria-label="Account name"
                  value={name}
                  disabled={pending}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Account B"
                />
              }
            />
            <SettingsRow
              title="Token"
              description={error ?? "Starts with sk-ant-oat."}
              control={
                <Input
                  aria-label="Claude token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  disabled={pending}
                  onChange={(event) => setToken(event.target.value)}
                />
              }
            />
          </form>
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-claude-account"
            disabled={pending || !ready || !canManageProviders}
          >
            {pending ? "Adding account…" : "Add account"}
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
