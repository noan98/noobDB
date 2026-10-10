import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import type { TableColumnInfo, TableRowIdentity } from "../api/tauri";
import { useT } from "../i18n";
import {
  applyTableOpenTemplate,
  tableQueryTemplateErrorMessage,
  validateTableQueryTemplate,
} from "../tableQueryTemplate";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, PressableButton, Textarea } from "./ui";

/**
 * テーブル別のデフォルトクエリ (#1253) を設定するモーダル。スキーマツリーの
 * テーブル右クリックから開く。保存前に検証し (不正なら保存ボタンを無効化して
 * `FieldError` で理由を出す)、列・行識別を取得できたら展開後の SQL と
 * 編集可否のプレビューを出す。
 */
interface Props {
  driver: string;
  database: string;
  table: string;
  limit: number;
  /** 既存の上書き (無ければ空文字列)。 */
  initialTemplate: string;
  /** 上書きが無いときに使われる全体テンプレート (空なら従来クエリ)。 */
  globalTemplate: string;
  /** プレビュー用に列と行識別を取得する。失敗してもプレビューを省くだけ。 */
  loadSchema: () => Promise<{ columns: TableColumnInfo[]; rowIdentity: TableRowIdentity | null }>;
  onSave: (template: string) => void;
  onClose: () => void;
}

export function TableOpenQueryModal({
  driver,
  database,
  table,
  limit,
  initialTemplate,
  globalTemplate,
  loadSchema,
  onSave,
  onClose,
}: Props) {
  const t = useT();
  const [template, setTemplate] = useState(initialTemplate);
  const [schema, setSchema] = useState<{
    columns: TableColumnInfo[];
    rowIdentity: TableRowIdentity | null;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 呼び出し側はインライン関数を渡すので、取得はマウント時の 1 回だけにする。
  const loadSchemaRef = useRef(loadSchema);
  useEffect(() => {
    let cancelled = false;
    loadSchemaRef.current()
      .then((s) => {
        if (!cancelled) setSchema(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const error = validateTableQueryTemplate(template, driver);
  const errorMsg = error ? tableQueryTemplateErrorMessage(error) : null;
  const effective = template.trim() !== "" ? template : globalTemplate;
  const preview = useMemo(() => {
    if (!schema || error) return null;
    return applyTableOpenTemplate({
      resolved: effective.trim() !== "" ? { template: effective, source: "override" } : null,
      driver,
      database,
      table,
      limit,
      columns: schema.columns,
      rowIdentity: schema.rowIdentity,
      legacyBase: "",
      legacySql: "",
    });
  }, [schema, error, effective, driver, database, table, limit]);

  const submit = () => {
    if (!error) onSave(template);
  };
  const hasOverride = initialTemplate.trim() !== "";

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={!!error}
      width="600px"
      onClose={onClose}
      initialFocusEl={() => textareaRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("tableOpenQueryModalCancel")}>
        {t("tableOpenQueryModalTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <FormSection>
          <FieldLabel htmlFor="table-open-query-template">{t("tableOpenQueryModalLabel")}</FieldLabel>
          <Textarea
            id="table-open-query-template"
            ref={textareaRef}
            rows={4}
            fontFamily="mono"
            fontSize="sm"
            spellCheck={false}
            value={template}
            placeholder={globalTemplate || "SELECT * FROM {table} ORDER BY {pk} DESC LIMIT {limit}"}
            aria-invalid={error ? true : undefined}
            onChange={(e) => setTemplate(e.target.value)}
          />
          {errorMsg && <FieldError>{t(errorMsg.key, errorMsg.vars)}</FieldError>}
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("tableOpenQueryModalHelp")}
          </chakra.span>
        </FormSection>
        {preview && (
          <FormSection>
            <FieldLabel as="div">{t("tableOpenQueryModalPreview")}</FieldLabel>
            <CodePreview wrap minH="40px">
              {preview.openTemplate ? preview.sql : t("tableOpenQueryModalPreviewLegacy")}
            </CodePreview>
            {preview.openTemplate && !preview.openTemplate.editable && (
              <Callout tone="warning" role="status">
                {t("tableOpenQueryModalReadOnly")}
              </Callout>
            )}
            {preview.openTemplate?.editable && !preview.openTemplate.keyset && (
              <Callout tone="info" role="status">
                {t("tableOpenQueryModalOffset")}
              </Callout>
            )}
          </FormSection>
        )}
      </ModalBody>
      <ModalFooter>
        {hasOverride && (
          <Button type="button" variant="dangerOutline" onClick={() => onSave("")}>
            {t("tableOpenQueryModalRemove")}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("tableOpenQueryModalCancel")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!!error} onClick={submit}>
          {t("tableOpenQueryModalSave")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
