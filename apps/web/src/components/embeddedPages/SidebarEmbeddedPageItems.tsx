import { useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EmbeddedPageIcon } from "./embeddedPageIcons";
import { useEmbeddedPages } from "./useEmbeddedPages";

/** One footer icon per configured page, rendered inside the sidebar utility row. */
export const SidebarEmbeddedPageItems = memo(function SidebarEmbeddedPageItems() {
  const pages = useEmbeddedPages();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  return pages.map((page) => (
    <SidebarMenuItem key={page.id} className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={page.name}
              size="icon"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void navigate({
                  to: "/embedded/$pageId",
                  params: { pageId: page.id },
                  search: {},
                });
              }}
            >
              <EmbeddedPageIcon icon={page.icon} />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{page.name}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  ));
});
