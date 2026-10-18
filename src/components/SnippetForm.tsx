import { useId, useMemo, useState } from "react";
import { Box, chakra } from "@chakra-ui/react";
import { api, ConnectionProfile, Snippet, SnippetScope } from "../api/tauri";
import { useT } from "../i18n";
import { Button, Heading, Input, Select, Textarea } from "./ui";
import { ComboSelect } from "./ComboSelect";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldError, FieldLabel } from "./modalForm";
import { isModalSubmitKey, pickModalKeys } from "./modalKeys";

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
  // フォーム内のラベルと入力を htmlFor / id で関連付けるための一意な接頭辞。
  // 同一画面に複数フォームがあっても衝突しないよう useId を使う (a11y)。
  const fid = useId();

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
      : (activeProfile?.id ?? profiles[0]?.id ?? ""),
  );
  const [scopeGroup, setScopeGroup] = useState(
    initial?.scope.kind === "group" ? initial.scope.group : (activeProfile?.group ?? ""),
  );

  // 入力不足は該当フィールドの FieldError に出す。保存 (IPC) の失敗だけ下部の ErrorNote。
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; sql?: string; scope?: string }>({});
  const [saving, setSaving] = useState(false);

  const buildScope = (): SnippetScope => {
    if (scopeKind === "profile") return { kind: "profile", profile_id: scopeProfileId };
    if (scopeKind === "group") return { kind: "group", group: scopeGroup.trim() };
    return { kind: "any" };
  };

  const handleSave = async () => {
    setError(null);
    const errors: { name?: string; sql?: string; scope?: string } = {};
    if (!name.trim()) errors.name = t("snippetErrorNameRequired");
    if (!sql.trim()) errors.sql = t("snippetErrorSqlRequired");
    if (scopeKind === "profile" && !scopeProfileId) errors.scope = t("snippetErrorScopeProfile");
    if (scopeKind === "group" && !scopeGroup.trim()) errors.scope = t("snippetErrorScopeGroup");
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      await api.saveSnippet({
        // 複製の下書きは id が空 (新規として保存する, #1631)。
        id: initial?.id || undefined,
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
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      p="4"
      display="grid"
      gridTemplateColumns="1fr 1fr"
      gap="3"
      overflowY="auto"
      // 接続フォーム / モーダルと同じく Cmd/Ctrl+Enter で保存する (#1114)。
      onKeyDown={(e) => {
        if (saving) return;
        if (!isModalSubmitKey(pickModalKeys(e))) return;
        e.preventDefault();
        void handleSave();
      }}
    >
      {/* 見出しは接続フォームと同じ共通 Heading (#1114)。 */}
      <Heading gridColumn="span 2">
        {initial?.id ? t("snippetEditTitle", { name: initial.name }) : t("snippetNewTitle")}
      </Heading>

      <Box gridColumn="span 2">
        <FieldLabel htmlFor={`${fid}-name`}>{t("snippetName")}</FieldLabel>
        <Input
          id={`${fid}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("snippetNamePlaceholder")}
          aria-invalid={fieldErrors.name ? true : undefined}
        />
        {fieldErrors.name && <FieldError>{fieldErrors.name}</FieldError>}
      </Box>

      <Box>
        <FieldLabel htmlFor={`${fid}-folder`}>{t("snippetFolder")}</FieldLabel>
        <ComboSelect
          id={`${fid}-folder`}
          value={folder}
          onChange={setFolder}
          options={folderSuggestions.map((f) => ({ value: f }))}
          placeholder={t("snippetFolderPlaceholder")}
        />
      </Box>

      <Box>
        <FieldLabel htmlFor={`${fid}-driver`}>{t("snippetDriver")}</FieldLabel>
        <Select id={`${fid}-driver`} value={driver} onChange={(e) => setDriver(e.target.value)}>
          <option value="">{t("snippetDriverAny")}</option>
          <option value="mysql">{t("formDriverMysql")}</option>
          <option value="postgres">{t("formDriverPostgres")}</option>
          <option value="sqlite">{t("formDriverSqlite")}</option>
        </Select>
      </Box>

      <Box gridColumn="span 2">
        <FieldLabel htmlFor={`${fid}-tags`}>{t("snippetTags")}</FieldLabel>
        <Input
          id={`${fid}-tags`}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t("snippetTagsPlaceholder")}
        />
        <chakra.p color="app.textMuted" fontSize="xs" mt="1" mx="0" mb="0">
          {t("snippetTagsHelp")}
        </chakra.p>
      </Box>

      <chakra.fieldset
        gridColumn="span 2"
        border="1px solid"
        borderColor="app.border"
        p="3"
        borderRadius="md"
      >
        <Heading as="legend" role="subheading" px="1.5">
          {t("snippetScope")}
        </Heading>
        <Box display="grid" gridTemplateColumns="1fr 1fr" gap="3">
          <Box>
            <FieldLabel htmlFor={`${fid}-scope-kind`}>{t("snippetScopeKind")}</FieldLabel>
            <Select
              id={`${fid}-scope-kind`}
              value={scopeKind}
              onChange={(e) => setScopeKind(e.target.value as ScopeKind)}
            >
              <option value="any">{t("snippetScopeAny")}</option>
              <option value="profile">{t("snippetScopeProfile")}</option>
              <option value="group">{t("snippetScopeGroup")}</option>
            </Select>
          </Box>
          {scopeKind === "profile" && (
            <Box>
              <FieldLabel htmlFor={`${fid}-scope-profile`}>{t("snippetScopeProfileLabel")}</FieldLabel>
              <Select
                id={`${fid}-scope-profile`}
                value={scopeProfileId}
                onChange={(e) => setScopeProfileId(e.target.value)}
              >
                {profiles.length === 0 && <option value="">—</option>}
                {scopeProfileId !== "" && !profiles.some((p) => p.id === scopeProfileId) && (
                  <option value={scopeProfileId}>{t("snippetScopeDeletedProfile")}</option>
                )}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Box>
          )}
          {scopeKind === "group" && (
            <Box>
              <FieldLabel htmlFor={`${fid}-scope-group`}>{t("snippetScopeGroupLabel")}</FieldLabel>
              <ComboSelect
                id={`${fid}-scope-group`}
                value={scopeGroup}
                onChange={setScopeGroup}
                options={groupSuggestions.map((g) => ({ value: g }))}
                placeholder={t("formGroupPlaceholder")}
              />
            </Box>
          )}
        </Box>
        {fieldErrors.scope && <FieldError>{fieldErrors.scope}</FieldError>}
        <chakra.p color="app.textMuted" fontSize="xs" mt="2" mx="0" mb="0">
          {t("snippetScopeHelp")}
        </chakra.p>
      </chakra.fieldset>

      <Box gridColumn="span 2">
        <FieldLabel htmlFor={`${fid}-sql`}>{t("snippetSql")}</FieldLabel>
        <Textarea
          id={`${fid}-sql`}
          fontFamily="mono"
          fontSize="md"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder={t("snippetSqlPlaceholder")}
          spellCheck={false}
          rows={10}
          aria-invalid={fieldErrors.sql ? true : undefined}
        />
        {fieldErrors.sql && <FieldError>{fieldErrors.sql}</FieldError>}
        <chakra.p textStyle="caption" color="app.textMuted" mt="1" mx="0" mb="0">
          {t("snippetSqlHelp")}
        </chakra.p>
      </Box>

      {/* 保存を止める持続的なエラーは ErrorNote (#1114)。 */}
      {error && (
        <ErrorNote gridColumn="span 2" role="alert">
          {error}
        </ErrorNote>
      )}

      <Box gridColumn="span 2" display="flex" gap="2" alignItems="center">
        <Box flex="1" />
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          {t("formCancel")}
        </Button>
        <LoadingButton pressable type="button" variant="primary" loading={saving} onClick={handleSave}>
          {t("formSave")}
        </LoadingButton>
      </Box>
    </Box>
  );
}
