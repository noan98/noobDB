import { useMemo, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { ConnectionProfile, Snippet } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { Checkbox, Input } from "./ui";
import {
  ScopeToggle,
  Tree,
  TreeBadge,
  TreeChevron,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreePane,
  TreeRow,
  TreeSearch,
} from "./tree";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";

interface Props {
  snippets: Snippet[];
  activeProfile: ConnectionProfile | null;
  onInsert: (snippet: Snippet) => void;
  onEdit: (snippet: Snippet) => void;
  onDelete: (id: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

/** True when `snippet` should be offered while connected to `profile`. */
export function scopeMatches(snippet: Snippet, profile: ConnectionProfile | null): boolean {
  const s = snippet.scope;
  if (s.kind === "any") return true;
  if (!profile) return false;
  if (s.kind === "profile") return s.profile_id === profile.id;
  if (s.kind === "group") return (profile.group ?? "") === s.group;
  return false;
}

export function SnippetList({ snippets, activeProfile, onInsert, onEdit, onDelete }: Props) {
  const t = useT();
  const [filter, setFilter] = useState("");
  const [showAllScopes, setShowAllScopes] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);

  const scopeFiltered = useMemo(() => {
    if (!activeProfile || showAllScopes) return snippets;
    return snippets.filter((s) => scopeMatches(s, activeProfile));
  }, [snippets, activeProfile, showAllScopes]);

  const visibleSnippets = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return scopeFiltered;
    return scopeFiltered.filter((s) => {
      if (s.name.toLowerCase().includes(q)) return true;
      if (s.folder?.toLowerCase().includes(q)) return true;
      if (s.sql.toLowerCase().includes(q)) return true;
      if (s.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [scopeFiltered, filter]);

  /** Snippets grouped by their `folder`. `null` key = no folder. */
  const grouped = useMemo(() => {
    const anyFoldered = scopeFiltered.some((s) => s.folder);
    if (!anyFoldered) return null;
    const map = new Map<string | null, Snippet[]>();
    for (const s of visibleSnippets) {
      const key = s.folder ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    const groups: { name: string | null; snippets: Snippet[] }[] = [];
    const names = Array.from(map.keys())
      .filter((k): k is string => k !== null)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) groups.push({ name, snippets: map.get(name)! });
    const unfiled = map.get(null);
    if (unfiled && unfiled.length > 0) groups.push({ name: null, snippets: unfiled });
    return groups;
  }, [scopeFiltered, visibleSnippets]);

  const handleContextMenu = (e: React.MouseEvent, s: Snippet) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: t("snippetMenuInsert"), onSelect: () => onInsert(s) },
        { label: t("snippetMenuEdit"), onSelect: () => onEdit(s) },
        {
          label: t("snippetMenuDelete"),
          danger: true,
          onSelect: () => {
            if (confirm(t("snippetDeleteConfirm", { name: s.name }))) onDelete(s.id);
          },
        },
      ],
    });
  };

  const renderSnippet = (s: Snippet) => (
    <TreeNode key={s.id}>
      <TreeRow
        role="treeitem"
        tabIndex={0}
        onDoubleClick={() => onInsert(s)}
        onKeyDown={(e) => {
          // Enter/Space は double-click と同じ「挿入」を実行。ダブルクリック
          // 必須にすると誤発火を避けたい意図だが、キーボードでは明示的な押下
          // なので 1 アクションで挿入する方が ARIA tree の慣習にも合う。
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onInsert(s);
          }
        }}
        onContextMenu={(e) => handleContextMenu(e, s)}
        title={`${t("snippetInsertHint")}\n\n${s.sql}`}
      >
        <TreeChevron visibility="hidden" aria-hidden />
        <TreeIcon color="app.accent" aria-hidden><Icon name="snippet" /></TreeIcon>
        <TreeLabel>{s.name}</TreeLabel>
        {s.tags.map((tag) => (
          <TreeBadge key={tag} textTransform="none" letterSpacing="0" fontFamily="mono">{tag}</TreeBadge>
        ))}
        {s.driver && <TreeBadge>{s.driver}</TreeBadge>}
      </TreeRow>
    </TreeNode>
  );

  return (
    <TreePane>
      <TreeSearch>
        <Input
          type="search"
          placeholder={t("snippetSearchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {activeProfile && (
          <ScopeToggle>
            <Checkbox
              checked={showAllScopes}
              onChange={(e) => setShowAllScopes(e.target.checked)}
            />
            {t("snippetShowAllScopes")}
          </ScopeToggle>
        )}
      </TreeSearch>

      {snippets.length === 0 ? (
        <EmptyState icon="snippet" title={t("snippetEmptyTitle")} description={t("snippetEmpty")} />
      ) : visibleSnippets.length === 0 ? (
        <chakra.p color="app.textMuted" p="12px">{t("snippetNoMatches")}</chakra.p>
      ) : (
        <Tree role="tree">
          {grouped === null
            ? visibleSnippets.map(renderSnippet)
            : grouped.map((g) => {
                const key = g.name ?? "__unfiled__";
                const folderOpen = expandedFolders[key] !== false;
                const label = g.name ?? t("snippetFolderNone");
                return (
                  <TreeNode key={key}>
                    <Box
                      display="flex"
                      alignItems="center"
                      gap="var(--space-1)"
                      whiteSpace="nowrap"
                      overflow="hidden"
                      userSelect="none"
                      cursor="pointer"
                      pt="6px"
                      pr="10px"
                      pb="6px"
                      pl="6px"
                      fontSize="xs"
                      textTransform="uppercase"
                      letterSpacing="0.06em"
                      color="app.textMuted"
                      bg="app.surfaceMuted"
                      borderTop="1px solid"
                      borderTopColor="app.borderSubtle"
                      borderBottom="1px solid"
                      borderBottomColor="app.borderSubtle"
                      borderLeft="2px solid transparent"
                      transitionProperty="background, color, border-color, box-shadow"
                      transitionDuration="var(--dur-fast)"
                      transitionTimingFunction="var(--ease)"
                      _hover={{ bg: "app.hover", color: "app.text" }}
                      onClick={() =>
                        setExpandedFolders((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpandedFolders((prev) => ({
                            ...prev,
                            [key]: prev[key] === false ? true : false,
                          }));
                        }
                      }}
                      role="treeitem"
                      tabIndex={0}
                      aria-expanded={folderOpen}
                    >
                      <TreeChevron aria-hidden>{folderOpen ? "▾" : "▸"}</TreeChevron>
                      <chakra.span flex="1" fontWeight={600} overflow="hidden" textOverflow="ellipsis">
                        {label}
                      </chakra.span>
                      <TreeBadge textTransform="none" letterSpacing="0">{g.snippets.length}</TreeBadge>
                    </Box>
                    {folderOpen && (
                      <Box display="flex" flexDirection="column">
                        {g.snippets.map(renderSnippet)}
                      </Box>
                    )}
                  </TreeNode>
                );
              })}
        </Tree>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </TreePane>
  );
}
