import { useMemo, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { ConnectionProfile, Snippet } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { Checkbox, Input } from "./ui";
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
    <Box key={s.id} className="tree-node snippet">
      <Box
        className="tree-row snippet-row"
        role="treeitem"
        onDoubleClick={() => onInsert(s)}
        onContextMenu={(e) => handleContextMenu(e, s)}
        title={`${t("snippetInsertHint")}\n\n${s.sql}`}
      >
        <chakra.span className="tree-chevron empty" aria-hidden />
        <chakra.span className="tree-icon snippet-icon" aria-hidden><Icon name="snippet" /></chakra.span>
        <chakra.span className="tree-label">{s.name}</chakra.span>
        {s.tags.map((tag) => (
          <chakra.span key={tag} className="tree-badge snippet-tag">{tag}</chakra.span>
        ))}
        {s.driver && <chakra.span className="tree-badge driver">{s.driver}</chakra.span>}
      </Box>
    </Box>
  );

  return (
    <Box className="tree-pane">
      <Box className="tree-search">
        <Input
          type="search"
          placeholder={t("snippetSearchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {activeProfile && (
          <chakra.label className="snippet-scope-toggle">
            <Checkbox
              checked={showAllScopes}
              onChange={(e) => setShowAllScopes(e.target.checked)}
            />
            {t("snippetShowAllScopes")}
          </chakra.label>
        )}
      </Box>

      {snippets.length === 0 ? (
        <EmptyState icon="snippet" title={t("snippetEmptyTitle")} description={t("snippetEmpty")} />
      ) : visibleSnippets.length === 0 ? (
        <chakra.p className="muted" p="12px">{t("snippetNoMatches")}</chakra.p>
      ) : (
        <Box className="tree" role="tree">
          {grouped === null
            ? visibleSnippets.map(renderSnippet)
            : grouped.map((g) => {
                const key = g.name ?? "__unfiled__";
                const folderOpen = expandedFolders[key] !== false;
                const label = g.name ?? t("snippetFolderNone");
                return (
                  <Box key={key} className="tree-node profile-group">
                    <Box
                      className="tree-row group-row"
                      onClick={() =>
                        setExpandedFolders((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }))
                      }
                      role="treeitem"
                      aria-expanded={folderOpen}
                    >
                      <chakra.span className="tree-chevron" aria-hidden>{folderOpen ? "▾" : "▸"}</chakra.span>
                      <chakra.span className="group-label">{label}</chakra.span>
                      <chakra.span className="tree-badge group-count">{g.snippets.length}</chakra.span>
                    </Box>
                    {folderOpen && (
                      <Box className="tree-children">
                        {g.snippets.map(renderSnippet)}
                      </Box>
                    )}
                  </Box>
                );
              })}
        </Box>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </Box>
  );
}
