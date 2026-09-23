import { useEffect, useRef, useState } from "react";
import { Flex } from "@chakra-ui/react";
import {
  api,
  type AssertionSql,
  type DriverKind,
  type RowCountOp,
  type SaveAssertionRequest,
} from "../api/tauri";
import { useT } from "../i18n";
import {
  ASSERTION_RULE_KINDS,
  RULE_KIND_LABEL_KEY,
  ROW_COUNT_OPS,
  ROW_COUNT_OP_SYMBOL,
  draftToRequest,
  draftToRule,
  type AssertionDraft,
  type AssertionDraftError,
  type AssertionRuleKind,
  type AssertionScopeKind,
} from "./assertions";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton, Select, Textarea } from "./ui";

/**
 * データ品質アサーション (#742) の追加・編集モーダル。
 *
 * 「開いて、決めて、閉じる」一時的な操作なので Modal に置く (一覧と実行結果は
 * ボトムパネル側、`ui-design-system.md` §7.1)。入力はすべて文字列のまま
 * `AssertionDraft` に持ち、保存時に純ロジック (`assertions.ts::draftToRequest`) で
 * ルールへ組み立てる。
 *
 * SQL プレビューは**バックエンドの生成器 (`preview_assertion_sql`) をそのまま呼ぶ**
 * — フロントで SQL を組み立てる二重実装を持たないため、ここで見える SQL が実行
 * される SQL と常に一致する。
 */
interface Props {
  initial: AssertionDraft;
  driver: DriverKind;
  /** スコープの解決に使う接続中プロファイル (未接続なら `null` = 全接続)。 */
  profile: { id: string; group?: string | null } | null;
  onSave: (req: SaveAssertionRequest) => Promise<void>;
  onClose: () => void;
}

const PREVIEW_DEBOUNCE_MS = 250;

export function AssertionEditorModal({ initial, driver, profile, onSave, onClose }: Props) {
  const t = useT();
  const [draft, setDraft] = useState<AssertionDraft>(initial);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AssertionSql | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const set = <K extends keyof AssertionDraft>(key: K, value: AssertionDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const ruleResult = draftToRule(draft);
  const requestResult = draftToRequest(draft, profile);
  const fieldError: AssertionDraftError | null =
    showErrors && !requestResult.ok ? requestResult.error : null;

  // ルールが組み立てられるときだけ、バックエンドの生成器でプレビューを取る。
  const ruleKey = ruleResult.ok
    ? JSON.stringify([draft.schema.trim(), draft.table.trim(), ruleResult.rule])
    : null;
  useEffect(() => {
    if (!ruleKey) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const [schema, table, rule] = JSON.parse(ruleKey) as [string, string, SaveAssertionRequest["rule"]];
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .previewAssertionSql({ driver, schema: schema || null, table, rule })
        .then((sql) => {
          if (cancelled) return;
          setPreview(sql);
          setPreviewError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(String(e));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ruleKey, driver]);

  const submit = async () => {
    if (!requestResult.ok) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(requestResult.req);
    } catch (e) {
      setSaveError(String(e));
      setSaving(false);
    }
  };

  const err = (code: AssertionDraftError, key: Parameters<typeof t>[0]) =>
    fieldError === code ? <FieldError>{t(key)}</FieldError> : null;

  const columnField = (
    <FormSection>
      <FieldLabel htmlFor="assert-column">{t("assertFieldColumn")}</FieldLabel>
      <Input
        id="assert-column"
        value={draft.column}
        onChange={(e) => set("column", e.target.value)}
        fontFamily="mono"
      />
      {err("column", "assertErrColumn")}
    </FormSection>
  );

  return (
    <Modal
      width="640px"
      onClose={onClose}
      initialFocusEl={() => nameRef.current}
      onSubmit={() => void submit()}
      submitDisabled={saving}
    >
      <ModalHeader onClose={onClose} closeLabel={t("assertCancel")}>
        {draft.id ? t("assertEditTitle") : t("assertAddTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3.5">
        <Flex gap="3" flexWrap="wrap">
          <FormSection flex="2" minW="200px">
            <FieldLabel htmlFor="assert-name">{t("assertFieldName")}</FieldLabel>
            <Input
              id="assert-name"
              ref={nameRef}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("assertFieldNamePlaceholder")}
            />
            {err("name", "assertErrName")}
          </FormSection>
          <FormSection flex="1" minW="160px">
            <FieldLabel htmlFor="assert-scope">{t("assertFieldScope")}</FieldLabel>
            <Select
              id="assert-scope"
              value={draft.scopeKind}
              onChange={(e) => set("scopeKind", e.target.value as AssertionScopeKind)}
            >
              <option value="profile">{t("assertScopeProfile")}</option>
              <option value="group">{t("assertScopeGroup")}</option>
              <option value="any">{t("assertScopeAny")}</option>
            </Select>
            {err("scopeGroup", "assertErrScopeGroup")}
          </FormSection>
        </Flex>

        <Flex gap="3" flexWrap="wrap">
          <FormSection flex="1" minW="160px">
            <FieldLabel htmlFor="assert-schema">{t("assertFieldSchema")}</FieldLabel>
            <Input
              id="assert-schema"
              value={draft.schema}
              onChange={(e) => set("schema", e.target.value)}
              placeholder={t("assertFieldSchemaPlaceholder")}
              fontFamily="mono"
            />
          </FormSection>
          <FormSection flex="1" minW="160px">
            <FieldLabel htmlFor="assert-table">{t("assertFieldTable")}</FieldLabel>
            <Input
              id="assert-table"
              value={draft.table}
              onChange={(e) => set("table", e.target.value)}
              fontFamily="mono"
            />
            {err("table", "assertErrTable")}
          </FormSection>
          <FormSection flex="1" minW="160px">
            <FieldLabel htmlFor="assert-kind">{t("assertFieldRule")}</FieldLabel>
            <Select
              id="assert-kind"
              value={draft.kind}
              onChange={(e) => set("kind", e.target.value as AssertionRuleKind)}
            >
              {ASSERTION_RULE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(RULE_KIND_LABEL_KEY[k])}
                </option>
              ))}
            </Select>
          </FormSection>
        </Flex>

        {draft.kind === "not_null" && columnField}

        {draft.kind === "unique" && (
          <FormSection>
            <FieldLabel htmlFor="assert-columns">{t("assertFieldColumns")}</FieldLabel>
            <Input
              id="assert-columns"
              value={draft.columns}
              onChange={(e) => set("columns", e.target.value)}
              placeholder={t("assertFieldColumnsPlaceholder")}
              fontFamily="mono"
            />
            {err("columns", "assertErrColumns")}
          </FormSection>
        )}

        {draft.kind === "accepted_values" && (
          <>
            {columnField}
            <FormSection>
              <FieldLabel htmlFor="assert-values">{t("assertFieldValues")}</FieldLabel>
              <Textarea
                id="assert-values"
                rows={4}
                value={draft.values}
                onChange={(e) => set("values", e.target.value)}
                placeholder={t("assertFieldValuesPlaceholder")}
                fontFamily="mono"
              />
              {err("values", "assertErrValues")}
            </FormSection>
          </>
        )}

        {draft.kind === "range" && (
          <>
            {columnField}
            <Flex gap="3">
              <FormSection flex="1">
                <FieldLabel htmlFor="assert-min">{t("assertFieldMin")}</FieldLabel>
                <Input
                  id="assert-min"
                  value={draft.min}
                  onChange={(e) => set("min", e.target.value)}
                  placeholder={t("assertFieldBoundPlaceholder")}
                  fontFamily="mono"
                />
              </FormSection>
              <FormSection flex="1">
                <FieldLabel htmlFor="assert-max">{t("assertFieldMax")}</FieldLabel>
                <Input
                  id="assert-max"
                  value={draft.max}
                  onChange={(e) => set("max", e.target.value)}
                  placeholder={t("assertFieldBoundPlaceholder")}
                  fontFamily="mono"
                />
              </FormSection>
            </Flex>
            {err("bounds", "assertErrBounds")}
          </>
        )}

        {draft.kind === "referential" && (
          <>
            <FormSection>
              <FieldLabel htmlFor="assert-columns">{t("assertFieldColumns")}</FieldLabel>
              <Input
                id="assert-columns"
                value={draft.columns}
                onChange={(e) => set("columns", e.target.value)}
                placeholder={t("assertFieldColumnsPlaceholder")}
                fontFamily="mono"
              />
              {err("columns", "assertErrColumns")}
            </FormSection>
            <Flex gap="3" flexWrap="wrap">
              <FormSection flex="1" minW="160px">
                <FieldLabel htmlFor="assert-ref-schema">{t("assertFieldRefSchema")}</FieldLabel>
                <Input
                  id="assert-ref-schema"
                  value={draft.refSchema}
                  onChange={(e) => set("refSchema", e.target.value)}
                  placeholder={t("assertFieldSchemaPlaceholder")}
                  fontFamily="mono"
                />
              </FormSection>
              <FormSection flex="1" minW="160px">
                <FieldLabel htmlFor="assert-ref-table">{t("assertFieldRefTable")}</FieldLabel>
                <Input
                  id="assert-ref-table"
                  value={draft.refTable}
                  onChange={(e) => set("refTable", e.target.value)}
                  fontFamily="mono"
                />
                {err("refTable", "assertErrRefTable")}
              </FormSection>
              <FormSection flex="1" minW="160px">
                <FieldLabel htmlFor="assert-ref-columns">{t("assertFieldRefColumns")}</FieldLabel>
                <Input
                  id="assert-ref-columns"
                  value={draft.refColumns}
                  onChange={(e) => set("refColumns", e.target.value)}
                  placeholder={t("assertFieldColumnsPlaceholder")}
                  fontFamily="mono"
                />
                {err("refColumns", "assertErrRefColumns")}
              </FormSection>
            </Flex>
          </>
        )}

        {draft.kind === "row_count" && (
          <Flex gap="3" flexWrap="wrap">
            <FormSection flex="1" minW="120px">
              <FieldLabel htmlFor="assert-op">{t("assertFieldOp")}</FieldLabel>
              <Select
                id="assert-op"
                value={draft.op}
                onChange={(e) => set("op", e.target.value as RowCountOp)}
              >
                {ROW_COUNT_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op === "between" ? t("assertOpBetween") : ROW_COUNT_OP_SYMBOL[op]}
                  </option>
                ))}
              </Select>
            </FormSection>
            <FormSection flex="1" minW="120px">
              <FieldLabel htmlFor="assert-count">
                {draft.op === "between" ? t("assertFieldMin") : t("assertFieldCount")}
              </FieldLabel>
              <Input
                id="assert-count"
                inputMode="numeric"
                value={draft.count}
                onChange={(e) => set("count", e.target.value)}
              />
              {err("count", "assertErrCount")}
            </FormSection>
            {draft.op === "between" && (
              <FormSection flex="1" minW="120px">
                <FieldLabel htmlFor="assert-count-max">{t("assertFieldMax")}</FieldLabel>
                <Input
                  id="assert-count-max"
                  inputMode="numeric"
                  value={draft.countMax}
                  onChange={(e) => set("countMax", e.target.value)}
                />
                {err("countMax", "assertErrCountMax")}
              </FormSection>
            )}
          </Flex>
        )}

        <FormSection>
          <FieldLabel as="div">{t("assertPreviewCheck")}</FieldLabel>
          <CodePreview wrap minH="40px" maxH="120px">
            {preview?.check_sql ?? (previewError ? previewError : t("assertPreviewEmpty"))}
          </CodePreview>
        </FormSection>
        <FormSection>
          <FieldLabel as="div">{t("assertPreviewViolations")}</FieldLabel>
          <CodePreview wrap minH="40px" maxH="120px">
            {preview?.violations_sql ?? t("assertPreviewEmpty")}
          </CodePreview>
        </FormSection>

        {saveError && <ErrorNote role="alert">{t("assertSaveError", { error: saveError })}</ErrorNote>}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          {t("assertCancel")}
        </Button>
        <PressableButton type="button" variant="primary" onClick={() => void submit()} disabled={saving}>
          {t("assertSave")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
