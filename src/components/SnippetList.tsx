import { useMemo, useState } from "react";
import { ConnectionProfile, Snippet } from "../api/tauri";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
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
    <div key={s.id} className="tree-node snippet">
      <div
        className="tree-row snippet-row"
        role="treeitem"
        onDoubleClick={() => onInsert(s)}
        onContextMenu={(e) => handleContextMenu(e, s)}
        title={`${t("snippetInsertHint")}\n\n${s.sql}`}
      >
        <span className="tree-chevron empty" aria-hidden />
        <span className="tree-icon snippet-icon" aria-hidden><Icon name="snippet" /></span>
        <span className="tree-label">{s.name}</span>
        {s.tags.map((tag) => (
          <span key={tag} className="tree-badge snippet-tag">{tag}</span>
        ))}
        {s.driver && <span className="tree-badge driver">{s.driver}</span>}
      </div>
    </div>
  );

  return (
    <div className="tree-pane">
      <div className="tree-search">
        <input
          type="search"
          placeholder={t("snippetSearchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {activeProfile && (
          <label className="snippet-scope-toggle">
            <input
              type="checkbox"
              checked={showAllScopes}
              onChange={(e) => setShowAllScopes(e.target.checked)}
            />
            {t("snippetShowAllScopes")}
          </label>
        )}
      </div>

      {snippets.length === 0 ? (
        <EmptyState icon="snippet" title={t("snippetEmptyTitle")} description={t("snippetEmpty")} />
      ) : visibleSnippets.length === 0 ? (
        <p className="muted" style={{ padding: 12 }}>{t("snippetNoMatches")}</p>
      ) : (
        <div className="tree" role="tree">
          {grouped === null
            ? visibleSnippets.map(renderSnippet)
            : grouped.map((g) => {
                const key = g.name ?? "__unfiled__";
                const folderOpen = expandedFolders[key] !== false;
                const label = g.name ?? t("snippetFolderNone");
                return (
                  <div key={key} className="tree-node profile-group">
                    <div
                      className="tree-row group-row"
                      onClick={() =>
                        setExpandedFolders((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }))
                      }
                      role="treeitem"
                      aria-expanded={folderOpen}
                    >
                      <span className="tree-chevron" aria-hidden>{folderOpen ? "▾" : "▸"}</span>
                      <span className="group-label">{label}</span>
                      <span className="tree-badge group-count">{g.snippets.length}</span>
                    </div>
                    {folderOpen && (
                      <div className="tree-children">
                        {g.snippets.map(renderSnippet)}
                      </div>
                    )}
                  </div>
                );
              })}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
