import { useMemo, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { api, ConnectionProfile, Snippet, SnippetScope } from "../api/tauri";
import { useT } from "../i18n";
import { Button, Input, Select, Textarea } from "./ui";

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
    <Box
      p="var(--space-4)"
      display="grid"
      gridTemplateColumns="1fr 1fr"
      gap="var(--space-3)"
      overflowY="auto"
    >
      <chakra.h2 gridColumn="span 2" m={0}>
        {initial ? t("snippetEditTitle", { name: initial.name }) : t("snippetNewTitle")}
      </chakra.h2>

      <Box gridColumn="span 2">
        <chakra.label>{t("snippetName")}</chakra.label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("snippetNamePlaceholder")}
        />
      </Box>

      <Box>
        <chakra.label>{t("snippetFolder")}</chakra.label>
        <Input
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
      </Box>

      <Box>
        <chakra.label>{t("snippetDriver")}</chakra.label>
        <Select value={driver} onChange={(e) => setDriver(e.target.value)}>
          <option value="">{t("snippetDriverAny")}</option>
          <option value="mysql">{t("formDriverMysql")}</option>
          <option value="postgres">{t("formDriverPostgres")}</option>
          <option value="sqlite">{t("formDriverSqlite")}</option>
        </Select>
      </Box>

      <Box gridColumn="span 2">
        <chakra.label>{t("snippetTags")}</chakra.label>
        <Input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t("snippetTagsPlaceholder")}
        />
        <chakra.p color="app.textMuted" fontSize="11px" m="4px 0 0">
          {t("snippetTagsHelp")}
        </chakra.p>
      </Box>

      <chakra.fieldset
        gridColumn="span 2"
        border="1px solid"
        borderColor="app.border"
        p="var(--space-3)"
        borderRadius="md"
      >
        <chakra.legend fontWeight={600} fontSize="sm" px="6px">{t("snippetScope")}</chakra.legend>
        <Box display="grid" gridTemplateColumns="1fr 1fr" gap="12px">
          <Box>
            <chakra.label>{t("snippetScopeKind")}</chakra.label>
            <Select value={scopeKind} onChange={(e) => setScopeKind(e.target.value as ScopeKind)}>
              <option value="any">{t("snippetScopeAny")}</option>
              <option value="profile">{t("snippetScopeProfile")}</option>
              <option value="group">{t("snippetScopeGroup")}</option>
            </Select>
          </Box>
          {scopeKind === "profile" && (
            <Box>
              <chakra.label>{t("snippetScopeProfileLabel")}</chakra.label>
              <Select value={scopeProfileId} onChange={(e) => setScopeProfileId(e.target.value)}>
                {profiles.length === 0 && <option value="">—</option>}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </Box>
          )}
          {scopeKind === "group" && (
            <Box>
              <chakra.label>{t("snippetScopeGroupLabel")}</chakra.label>
              <Input
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
            </Box>
          )}
        </Box>
        <chakra.p color="app.textMuted" fontSize="11px" m="8px 0 0">
          {t("snippetScopeHelp")}
        </chakra.p>
      </chakra.fieldset>

      <Box gridColumn="span 2">
        <chakra.label>{t("snippetSql")}</chakra.label>
        <Textarea
          fontFamily="mono"
          fontSize="md"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder={t("snippetSqlPlaceholder")}
          spellCheck={false}
          rows={10}
        />
      </Box>

      {error && <Box gridColumn="span 2" color="app.textError">{error}</Box>}

      <Box gridColumn="span 2" display="flex" gap="var(--space-2)" justifyContent="flex-end">
        <Button type="button" variant="secondary" onClick={onCancel}>{t("formCancel")}</Button>
        <Button type="button" variant="primary" onClick={handleSave}>{t("formSave")}</Button>
      </Box>
    </Box>
  );
}
