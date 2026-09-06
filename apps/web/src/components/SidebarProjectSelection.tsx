import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type RefObject,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import type { Project } from "../types";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useUiStateStore } from "../uiStateStore";
import { useAllEnvironmentProjectSnapshotsReady } from "../state/entities";
import {
  buildGeneralChatSidebarSnapshot,
  GENERAL_CHAT_PROJECT_KEY,
  projectGroupsSpanEnvironments,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import {
  filterSidebarProjectScopeItems,
  reduceSidebarProjectScopeMenuState,
} from "./Sidebar.logic";
import {
  isolateProjectKey,
  migrateLegacyProjectScope,
  pruneHiddenProjectKeys,
  resolveAllProjectsCheckboxState,
  resolveIsolatedProjectKey,
  resolveVisibleProjectRefKeys,
  toggleAllHiddenProjectKeys,
  toggleHiddenProjectKey,
} from "./sidebarProjectScope";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
  useComboboxFilter,
} from "./ui/combobox";
import { SidebarHeaderIconButton } from "./sidebar/SidebarThreadHeader";
import { Button } from "./ui/button";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProjectEnvironmentBadge } from "./ProjectEnvironmentBadge";
import { CheckIcon, FolderIcon, ListFilterIcon, MinusIcon, SettingsIcon } from "lucide-react";
import { cn } from "../lib/utils";

interface ProjectScopeItem {
  readonly value: string;
  readonly label: string;
}
const NO_PROJECT_SCOPE_ITEM: ProjectScopeItem | null = null;

export function useSidebarProjectSelection({
  chatProjects,
  projectGroups,
  primaryEnvironmentId,
  environmentLabelById,
}: {
  chatProjects: readonly Project[];
  projectGroups: readonly SidebarProjectSnapshot[];
  primaryEnvironmentId: EnvironmentId | null;
  environmentLabelById: ReadonlyMap<EnvironmentId, string>;
}) {
  // General chat filters like any project and heads the filter list.
  const projectFilterGroups = useMemo(() => {
    const generalChat = buildGeneralChatSidebarSnapshot({
      projects: chatProjects,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
    });
    return generalChat ? [generalChat, ...projectGroups] : projectGroups;
  }, [chatProjects, environmentLabelById, primaryEnvironmentId, projectGroups]);
  const projectFilterGroupsRef = useRef(projectFilterGroups);
  useEffect(() => {
    projectFilterGroupsRef.current = projectFilterGroups;
  }, [projectFilterGroups]);

  // Project filter: one menu above the list. The persisted hidden set is its
  // only state: checkboxes toggle a project, and clicking a row leaves just
  // that project visible. Filtering never makes the header width depend on
  // the number or length of project names.
  // {value, label} items let Base UI drive the combobox selection contract
  // while the popup search filters the same collection.
  const projectScopeItems = useMemo(
    () =>
      projectFilterGroups.map((project): ProjectScopeItem => ({
        value: project.projectKey,
        label: project.displayName,
      })),
    [projectFilterGroups],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const projectGroupByScopeKey = useMemo(
    () => new Map(projectFilterGroups.map((project) => [project.projectKey, project] as const)),
    [projectFilterGroups],
  );
  const [projectScopeMenuState, dispatchProjectScopeMenu] = useReducer(
    reduceSidebarProjectScopeMenuState,
    { open: false, query: "" },
  );
  const projectScopeFilter = useComboboxFilter();
  // Filtering derives from the same React state that controls the input, so
  // the visible query and the visible list can never desync — the peer wiring
  // in DiffPanel and BranchToolbarBranchSelector.
  const filteredProjectScopeItems = useMemo(
    () =>
      filterSidebarProjectScopeItems({
        items: projectScopeItems,
        query: projectScopeMenuState.query,
        matches: (item, query) =>
          projectScopeFilter.contains(item, query, (candidate) => candidate.label),
      }),
    [projectScopeFilter, projectScopeItems, projectScopeMenuState.query],
  );
  const updateSettings = useUpdateClientSettings();
  const hiddenProjectKeys = useClientSettings((settings) => settings.sidebarHiddenProjectKeys);
  const allProjectsCheckboxState = useMemo(
    () => resolveAllProjectsCheckboxState(hiddenProjectKeys, projectFilterGroups),
    [hiddenProjectKeys, projectFilterGroups],
  );
  const allProjectSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const visibleProjectGroups = useMemo(
    () => projectFilterGroups.filter((project) => !hiddenProjectKeys.includes(project.projectKey)),
    [hiddenProjectKeys, projectFilterGroups],
  );
  const isolatedProjectKey = useMemo(
    () => resolveIsolatedProjectKey(hiddenProjectKeys, projectFilterGroups),
    [hiddenProjectKeys, projectFilterGroups],
  );
  const scopedProjectGroup =
    isolatedProjectKey === null ? null : (projectGroupByScopeKey.get(isolatedProjectKey) ?? null);
  const scopedProjectKeys = useMemo(
    () => resolveVisibleProjectRefKeys(hiddenProjectKeys, projectFilterGroups),
    [hiddenProjectKeys, projectFilterGroups],
  );
  const projectScopeTriggerLabel =
    scopedProjectGroup?.displayName ??
    (allProjectsCheckboxState === "all"
      ? "All projects"
      : allProjectsCheckboxState === "none"
        ? "No projects"
        : `${visibleProjectGroups.length} projects`);
  // Any filter change drops the selection: rows selected under the old filter
  // may be hidden now, and bulk actions must never count or touch invisible rows.
  const settledResetKey = [...hiddenProjectKeys].sort().join(",");
  const setHiddenProjectKeys = useCallback(
    (nextHiddenProjectKeys: readonly string[]) => {
      updateSettings({ sidebarHiddenProjectKeys: [...nextHiddenProjectKeys] });
    },
    [updateSettings],
  );
  useEffect(() => {
    if (!allProjectSnapshotsReady) return;
    const pruned = pruneHiddenProjectKeys(hiddenProjectKeys, projectFilterGroups);
    if (pruned !== hiddenProjectKeys) setHiddenProjectKeys(pruned);
  }, [allProjectSnapshotsReady, hiddenProjectKeys, projectFilterGroups, setHiddenProjectKeys]);
  // Earlier builds kept a separate single-project scope (upstream's UI-store
  // key) that overrode the checkboxes. Fold it into the hidden set once its
  // project is known, or drop it once every environment has reported and the
  // project is gone. Cached or disconnected environments cannot establish that.
  const legacyProjectScopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const setLegacyProjectScopeKey = useUiStateStore((store) => store.setSidebarProjectScopeKey);
  useEffect(() => {
    const migrated = migrateLegacyProjectScope({
      legacyProjectScopeKey,
      hiddenProjectKeys,
      projectGroups: projectFilterGroups,
      allSnapshotsReady: allProjectSnapshotsReady,
    });
    if (migrated.hiddenProjectKeys !== hiddenProjectKeys)
      setHiddenProjectKeys(migrated.hiddenProjectKeys);
    if (migrated.legacyProjectScopeKey !== legacyProjectScopeKey)
      setLegacyProjectScopeKey(migrated.legacyProjectScopeKey);
  }, [
    allProjectSnapshotsReady,
    legacyProjectScopeKey,
    hiddenProjectKeys,
    projectFilterGroups,
    setHiddenProjectKeys,
    setLegacyProjectScopeKey,
  ]);
  return {
    projectFilterGroups,
    projectFilterGroupsRef,
    projectScopeItems,
    showProjectEnvironments,
    projectGroupByScopeKey,
    projectScopeMenuState,
    dispatchProjectScopeMenu,
    filteredProjectScopeItems,
    hiddenProjectKeys,
    allProjectsCheckboxState,
    visibleProjectGroups,
    isolatedProjectKey,
    scopedProjectGroup,
    scopedProjectKeys,
    projectScopeTriggerLabel,
    settledResetKey,
    setHiddenProjectKeys,
  };
}

export function SidebarProjectSelection({
  selection,
  headerSearchRef,
  openProjectSettings,
  primaryEnvironmentId,
  environmentMachineById,
}: {
  selection: ReturnType<typeof useSidebarProjectSelection>;
  headerSearchRef: RefObject<HTMLDivElement | null>;
  openProjectSettings: (group: SidebarProjectSnapshot) => void;
  primaryEnvironmentId: EnvironmentId | null;
  environmentMachineById: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  const {
    projectScopeItems,
    filteredProjectScopeItems,
    projectScopeMenuState,
    dispatchProjectScopeMenu,
    setHiddenProjectKeys,
    hiddenProjectKeys,
    projectFilterGroups,
    scopedProjectGroup,
    projectScopeTriggerLabel,
    projectGroupByScopeKey,
    allProjectsCheckboxState,
    isolatedProjectKey,
    showProjectEnvironments,
  } = selection;
  // Safari can send a click after Ctrl+click opens settings. Ignore that one
  // selection, then clear the guard when the picker opens again.
  const suppressNextScopeChangeRef = useRef(false);
  const highlightedProjectScopeKeyRef = useRef<string | null>(null);
  const handleProjectSettings = useCallback(
    (
      event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLInputElement>,
      projectGroup: SidebarProjectSnapshot,
    ) => {
      // General chat is a filter entry, not a project with settings.
      if (projectGroup.projectKey === GENERAL_CHAT_PROJECT_KEY) return;
      event.preventDefault();
      event.stopPropagation();
      suppressNextScopeChangeRef.current = true;
      dispatchProjectScopeMenu({ type: "project-settings-opened" });
      openProjectSettings(projectGroup);
    },
    [dispatchProjectScopeMenu, openProjectSettings],
  );

  return (
    <Combobox
      items={projectScopeItems}
      filteredItems={filteredProjectScopeItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={projectScopeMenuState.open}
      onOpenChange={(open) => {
        if (open) suppressNextScopeChangeRef.current = false;
        dispatchProjectScopeMenu({ type: "open-changed", open });
      }}
      onItemHighlighted={(item) => {
        highlightedProjectScopeKeyRef.current = item?.value ?? null;
      }}
      // Rows act on click rather than holding a selection, so a
      // second click on the isolated project can bring all back.
      value={NO_PROJECT_SCOPE_ITEM}
      onValueChange={(item) => {
        if (suppressNextScopeChangeRef.current) {
          suppressNextScopeChangeRef.current = false;
          return;
        }
        if (!item) return;
        setHiddenProjectKeys(isolateProjectKey(hiddenProjectKeys, projectFilterGroups, item.value));
      }}
    >
      <ComboboxTrigger
        render={
          <SidebarHeaderIconButton
            label={`Filter threads by project: ${projectScopeTriggerLabel}`}
          />
        }
      >
        {scopedProjectGroup ? (
          // Wrapped so the button's direct-child svg color rule cannot override
          // a project's own icon color.
          <span className="flex shrink-0">
            <ProjectFavicon project={scopedProjectGroup} className="size-4" />
          </span>
        ) : (
          <ListFilterIcon className="size-4" />
        )}
      </ComboboxTrigger>
      <ComboboxPopup
        align="start"
        // Anchored to the search field, not the 28px trigger: the
        // popup opens under the field, is at least as wide as it,
        // and grows to fit project names up to a cap, past which
        // the rows truncate.
        anchor={headerSearchRef}
        className="max-w-[min(18rem,var(--available-width))] overflow-hidden"
      >
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Search projects..."
          value={projectScopeMenuState.query}
          onKeyDown={(event) => {
            if (
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
            ) {
              return;
            }
            // Combobox items use virtual focus: keyboard events
            // stay on this input, not on the highlighted option.
            const scopeKey = highlightedProjectScopeKeyRef.current;
            const project = scopeKey ? projectGroupByScopeKey.get(scopeKey) : null;
            if (project) handleProjectSettings(event, project);
          }}
          onChange={(event) =>
            dispatchProjectScopeMenu({
              type: "query-changed",
              query: event.target.value,
            })
          }
        />
        <button
          type="button"
          role="checkbox"
          aria-checked={
            allProjectsCheckboxState === "all"
              ? true
              : allProjectsCheckboxState === "none"
                ? false
                : "mixed"
          }
          className="grid h-8 w-full cursor-pointer grid-cols-[1rem_1fr] items-center gap-2 px-3 text-left text-sm font-medium hover:bg-accent"
          onClick={() => {
            setHiddenProjectKeys(
              toggleAllHiddenProjectKeys(hiddenProjectKeys, projectFilterGroups),
            );
          }}
        >
          <span className="flex size-4 items-center justify-center">
            {allProjectsCheckboxState === "all" ? (
              <CheckIcon className="size-3.5" />
            ) : allProjectsCheckboxState === "partial" ? (
              <MinusIcon className="size-3.5" />
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-2">
            <FolderIcon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">All projects</span>
          </span>
        </button>
        <div className="mx-2 h-px bg-border" />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: (typeof projectScopeItems)[number]) => {
            const project = projectGroupByScopeKey.get(item.value) ?? null;
            const projectHidden =
              project !== null && hiddenProjectKeys.includes(project.projectKey);
            const isGeneralChat = item.value === GENERAL_CHAT_PROJECT_KEY;
            const isIsolated = item.value === isolatedProjectKey;
            return (
              <ComboboxItem
                key={item.value}
                hideIndicator
                className="group"
                value={item}
                onContextMenu={(event) => {
                  if (project) handleProjectSettings(event, project);
                }}
              >
                {project ? (
                  <>
                    <button
                      type="button"
                      aria-label={
                        projectHidden
                          ? `Show ${project.displayName}`
                          : `Hide ${project.displayName}`
                      }
                      aria-pressed={!projectHidden}
                      className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-accent"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setHiddenProjectKeys(
                          toggleHiddenProjectKey(hiddenProjectKeys, project.projectKey),
                        );
                      }}
                    >
                      {!projectHidden ? <CheckIcon className="size-3.5" /> : null}
                    </button>
                    <ProjectFavicon project={project} className="size-4 shrink-0" />
                  </>
                ) : (
                  <FolderIcon className="size-4 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                {/* Names what a row click does. Hidden rows keep its space so
                                hovering never re-truncates the name. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "shrink-0 text-xs text-muted-foreground",
                    !isIsolated && "invisible group-data-highlighted:visible",
                  )}
                >
                  {isIsolated ? "Show all" : "Only"}
                </span>
                {project && !isGeneralChat && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={project}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
                {project && !isGeneralChat ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    tabIndex={-1}
                    aria-hidden="true"
                    title={`Project settings for ${project.displayName}`}
                    className="ml-auto"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      void handleProjectSettings(event, project);
                    }}
                  >
                    <SettingsIcon className="size-3.5" />
                  </Button>
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
