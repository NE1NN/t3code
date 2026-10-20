import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { DecisionsPage } from "../components/decisions/DecisionsPage";

interface DecisionsSearch {
  readonly decision?: string;
}

export const Route = createFileRoute("/_chat/decisions")({
  validateSearch: (raw: Record<string, unknown>): DecisionsSearch =>
    typeof raw.decision === "string" && raw.decision ? { decision: raw.decision } : {},
  component: DecisionsRouteView,
});

function DecisionsRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <DecisionsPage
      selectedKey={search.decision}
      onSelect={(decision) => void navigate({ search: decision ? { decision } : {} })}
    />
  );
}
