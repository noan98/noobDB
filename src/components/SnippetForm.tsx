import { useMemo, useState } from "react";
import { api, ConnectionProfile, Snippet, SnippetScope } from "../api/tauri";
import { useT } from "../i18n";

interface Props {
  initial: Snippet | null;
  snippets: Snippet[];
  profiles: ConnectionProfile[];
  activeProfile: ConnectionProfile | null;
  /** Pre-fills the SQL body when creating a snippet from the editor. */
  initialSql?: string;
  onSaved: () => void;
  onCancel: () => void;
}

type ScopeKind = SnippetScope["kind"];

export function SnippetForm({
  initial,
  snippets,
  profiles,
  activeProfile,
  initialSql,
  onSaved,
  onCancel,
}: Props) {
  const t = useT();

  const folderSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const s of snippets) {
      if (s.folder && s.folder.trim()) set.add(s.folder);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [snippets]);

  const groupSuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const p of profiles) {
      if (p.group && p.group.trim()) set.add(p.group);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [profiles]);

  const [name, setName] = useState(initial?.name ?? "");
  const [folder, setFolder] = useState(initial?.folder ?? "");
  const [tags, setTags] = useState(initial ? initial.tags.join(", ") : "");
  const [sql, setSql] = useState(initial?.sql ?? initialSql ?? "");
  const [driver, setDriver] = useState(initial?.driver ?? activeProfile?.driver ?? "");

  const [scopeKind, setScopeKind] = useState<ScopeKind>(initial?.scope.kind ?? "any");
  const [scopeProfileId, setScopeProfileId] = useState(
    initial?.scope.kind === "profile"
      ? initial.scope.profile_id
      : activeProfile?.id ?? profiles[0]?.id ?? "",
  );
  const [scopeGroup, setScopeGroup] = useState(
    initial?.scope.kind === "group"
      ? initial.scope.group
      : activeProfile?.group ?? "",
  );

  const [error, setError] = useState<string | null>(null);

  const buildScope = (): SnippetScope => {
    if (scopeKind === "profile") return { kind: "profile", profile_id: scopeProfileId };
    if (scopeKind === "group") return { kind: "group", group: scopeGroup.trim() };
    return { kind: "any" };
  };

  const handleSave = async () => {
    setError(null);
    if (!name.trim()) {
      setError(t("snippetErrorNameRequired"));
      return;
    }
    if (!sql.trim()) {
      setError(t("snippetErrorSqlRequired"));
      return;
    }
    if (scopeKind === "profile" && !scopeProfileId) {
      setError(t("snippetErrorScopeProfile"));
      return;
    }
    if (scopeKind === "group" && !scopeGroup.trim()) {
      setError(t("snippetErrorScopeGroup"));
      return;
    }
    try {
      await api.saveSnippet({
        id: initial?.id,
        name: name.trim(),
        folder: folder.trim() || null,
        tags: tags
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        sql,
        driver: driver || null,
        scope: buildScope(),
      });
      onSaved();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="form">
      <h2 className="full" style={{ margin: 0 }}>
        {initial ? t("snippetEditTitle", { name: initial.name }) : t("snippetNewTitle")}
      </h2>

      <div className="full">
        <label>{t("snippetName")}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("snippetNamePlaceholder")}
        />
      </div>

      <div>
        <label>{t("snippetFolder")}</label>
        <input
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          placeholder={t("snippetFolderPlaceholder")}
          list="snippet-folder-suggestions"
        />
        <datalist id="snippet-folder-suggestions">
          {folderSuggestions.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>

      <div>
        <label>{t("snippetDriver")}</label>
        <select value={driver} onChange={(e) => setDriver(e.target.value)}>
          <option value="">{t("snippetDriverAny")}</option>
          <option value="mysql">{t("formDriverMysql")}</option>
          <option value="postgres">{t("formDriverPostgres")}</option>
          <option value="sqlite">{t("formDriverSqlite")}</option>
        </select>
      </div>

      <div className="full">
        <label>{t("snippetTags")}</label>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t("snippetTagsPlaceholder")}
        />
        <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
          {t("snippetTagsHelp")}
        </p>
      </div>

      <fieldset className="full">
        <legend>{t("snippetScope")}</legend>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label>{t("snippetScopeKind")}</label>
            <select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as ScopeKind)}>
              <option value="any">{t("snippetScopeAny")}</option>
              <option value="profile">{t("snippetScopeProfile")}</option>
              <option value="group">{t("snippetScopeGroup")}</option>
            </select>
          </div>
          {scopeKind === "profile" && (
            <div>
              <label>{t("snippetScopeProfileLabel")}</label>
              <select value={scopeProfileId} onChange={(e) => setScopeProfileId(e.target.value)}>
                {profiles.length === 0 && <option value="">—</option>}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}
          {scopeKind === "group" && (
            <div>
              <label>{t("snippetScopeGroupLabel")}</label>
              <input
                value={scopeGroup}
                onChange={(e) => setScopeGroup(e.target.value)}
                placeholder={t("formGroupPlaceholder")}
                list="snippet-group-suggestions"
              />
              <datalist id="snippet-group-suggestions">
                {groupSuggestions.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </div>
          )}
        </div>
        <p className="muted" style={{ fontSize: 11, margin: "8px 0 0" }}>
          {t("snippetScopeHelp")}
        </p>
      </fieldset>

      <div className="full">
        <label>{t("snippetSql")}</label>
        <textarea
          className="snippet-sql"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder={t("snippetSqlPlaceholder")}
          spellCheck={false}
          rows={10}
        />
      </div>

      {error && <div className="full text-error">{error}</div>}

      <div className="actions">
        <button onClick={onCancel}>{t("formCancel")}</button>
        <button className="primary" onClick={handleSave}>{t("formSave")}</button>
      </div>
    </div>
  );
}
