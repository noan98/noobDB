import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DriverKind } from "../api/tauri";
import { useT } from "../i18n";
import {
  buildApplyRoutineStatements,
  buildRestoreStatement,
  buildRoutineTemplate,
  routineApplyIsAtomic,
  type EditableObjectKind,
} from "./routineMaintenance";
import { useConfirm } from "./ConfirmDialog";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Button, PressableButton, Textarea } from "./ui";

/**
 * ルーチン (プロシージャ / 関数)・トリガーの新規作成 / 定義編集 (#1192)。
 *
 * 編集: `get_object_definition` の DDL をテキスト欄へ読み込み、`routineMaintenance.ts`
 * が組み立てた置換文を `run_query_transaction` で適用する。文は 1 件ずつ execute される
 * ので、MySQL / SQLite の `BEGIN ... END` 本体の `;` は分割されない。PostgreSQL /
 * SQLite は 1 トランザクションなので失敗しても旧定義が残る。MySQL は DDL を巻き戻せない
 * ため、適用前に確認ダイアログで明示し、失敗時は元の定義の復元を試みる。
 * 新規作成: ドライバ別テンプレートを初期値にする。`read_only` のセッションでは適用不可
 * (バックエンドの `ensure_allowed_for_session` も拒否する)。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string;
  kind: EditableObjectKind;
  /** 編集対象の名前。null なら新規作成。 */
  name: string | null;
  /** PostgreSQL の oid (オーバーロード / 同名トリガーの解決用)。 */
  id: string | null;
  readOnly: boolean;
  /** 適用成功。`created` は新規作成だったか。 */
  onApplied: (created: boolean) => void;
  onClose: () => void;
}

const KIND_LABEL_KEYS = {
  procedure: "routineEditKindProcedure",
  function: "routineEditKindFunction",
  trigger: "routineEditKindTrigger",
} as const;

export function RoutineEditorModal({
  sessionId,
  driver,
  database,
  kind,
  name,
  id,
  readOnly,
  onApplied,
  onClose,
}: Props) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const editing = name !== null;
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState(() => (editing ? "" : buildRoutineTemplate(driver, kind, database)));
  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (name === null) return;
    let alive = true;
    api
      .getObjectDefinition(sessionId, database, kind, name, id)
      .then((ddl) => {
        if (!alive) return;
        setOriginal(ddl);
        setText(ddl);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, database, kind, name, id]);

  const built = useMemo(
    () =>
      buildApplyRoutineStatements({ driver, database, kind, name, originalDdl: original, ddl: text }),
    [driver, database, kind, name, original, text],
  );
  const kindLabel = t(KIND_LABEL_KEYS[kind]);
  const atomic = routineApplyIsAtomic(driver);
  const canApply = !readOnly && !loading && !loadError && !busy && built.ok;

  const apply = async () => {
    if (!canApply || !built.ok) return;
    setError(null);
    if (editing && !atomic) {
      const ok = await confirm({
        title: t("routineEditConfirmTitle", { name: name ?? "" }),
        message: t("routineEditConfirmBody", { name: name ?? "" }),
        confirmLabel: t("routineEditConfirmApply"),
        tone: "danger",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.runQueryTransaction(sessionId, built.statements, database);
      onApplied(!editing);
    } catch (e) {
      const msg = String(e);
      if (editing && !atomic && original) {
        // MySQL: DROP 後に CREATE が失敗すると定義が消えるので、元の定義を戻す。
        // DROP 自体が失敗していた場合は「既に存在する」で失敗するだけで無害。
        try {
          await api.runQuery(sessionId, buildRestoreStatement(driver, original), database);
          setError(t("routineEditFailedRestored", { error: msg }));
        } catch {
          setError(t("routineEditFailedNotRestored", { error: msg }));
        }
      } else {
        setError(t("routineEditFailed", { error: msg }));
      }
    } finally {
      setBusy(false);
    }
  };

  const title = editing
    ? t("routineEditTitleEdit", { kind: kindLabel, name: name ?? "" })
    : t("routineEditTitleCreate", { kind: kindLabel });
  const validation = !built.ok && text.trim().length > 0 ? t(built.error, built.vars) : null;

  return (
    <>
      <Modal
        onSubmit={() => void apply()}
        submitDisabled={!canApply}
        width="760px"
        onClose={onClose}
        initialFocusEl={() => areaRef.current}
      >
        <ModalHeader onClose={onClose} closeLabel={t("routineEditClose")}>
          {title}
        </ModalHeader>
        <ModalBody display="flex" flexDirection="column" gap="4">
          {readOnly && <Callout tone="warning">{t("routineEditReadOnly")}</Callout>}
          {loadError && <ErrorNote role="alert">{t("routineEditLoadError", { error: loadError })}</ErrorNote>}
          <FormSection>
            <FieldLabel htmlFor="routine-editor-sql">{t("routineEditSqlLabel")}</FieldLabel>
            <Textarea
              id="routine-editor-sql"
              ref={areaRef}
              rows={18}
              value={loading ? t("routineEditLoading") : text}
              disabled={loading || !!loadError}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              fontFamily="mono"
              fontSize="sm"
              whiteSpace="pre"
              overflowX="auto"
            />
            {validation && <ErrorNote>{validation}</ErrorNote>}
          </FormSection>
          <Callout tone={atomic ? "info" : "warning"}>
            {atomic ? t("routineEditNoteAtomic") : t("routineEditNoteMysql")}
            {driver === "mysql" ? ` ${t("routineEditNoteMysqlDelimiter")}` : ""}
          </Callout>
          {built.ok && (
            <FormSection>
              <FieldLabel as="div">{t("routineEditPreviewLabel")}</FieldLabel>
              <CodePreview minH="60px" maxH="200px">
                {built.statements.join("\n")}
              </CodePreview>
            </FormSection>
          )}
          {error && <ErrorNote role="alert">{error}</ErrorNote>}
        </ModalBody>
        <ModalFooter>
          <div style={{ flex: 1 }} />
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("routineEditClose")}
          </Button>
          <PressableButton type="button" variant="primary" disabled={!canApply} onClick={() => void apply()}>
            {editing ? t("routineEditApply") : t("routineEditCreate")}
          </PressableButton>
        </ModalFooter>
      </Modal>
      {dialog}
    </>
  );
}
