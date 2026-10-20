import { Link, useLocation } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";

import { useDecisionQueue } from "~/state/decisions";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function SidebarDecisionsEntry() {
  const { items } = useDecisionQueue();
  const { isMobile, setOpenMobile } = useSidebar();
  const isActive = useLocation({ select: (location) => location.pathname === "/decisions" });
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={isActive}
          render={<Link to="/decisions" />}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <InboxIcon className="text-decision-foreground!" />
          <span className="min-w-0 flex-1 truncate">Decisions</span>
          {items.length > 0 ? (
            <span className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-decision px-1.5 font-semibold text-2xs text-white tabular-nums">
              {items.length}
            </span>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
