import { createFileRoute } from "@tanstack/react-router";

import { ClaudeAccountsSettings } from "../components/settings/ClaudeAccountsSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

function SettingsAccountsRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage its Claude accounts.`
          : "Connect an environment to manage its Claude accounts."}
      </p>
    );
  }
  return <ClaudeAccountsSettings environmentId={environment.environmentId} />;
}

export const Route = createFileRoute("/settings/accounts")({
  component: SettingsAccountsRoute,
});
