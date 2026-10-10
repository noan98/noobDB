import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type DriverKind } from "../api/tauri";
import { useT } from "../i18n";
import {
  buildCloneStatements,
  buildPgColumnFlagsSql,
  buildPgForeignKeysSql,
  formatCloneStatements,
  insertableColumns,
  parsePgColumnFlags,
  parsePgForeignKeys,
  type PgColumnFlags,
  type PgForeignKey,
  suggestCloneName,
} from "../tableClone";
import { tableNameCollides } from "./resultsToTable";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton, Switch } from "./ui";
import { Spinner } from "./Spinner";

/**
 * テーブル複製ダイアログ (#1398)。
 *
 * `get_object_definition(kind="table")` の CREATE TABLE DDL を取得し、新しい名前向けに
 * 書き換えた文 (`tableClone.ts`) を CodePreview に見せる。「データも複製」を選ぶと末尾に
 * `INSERT INTO new SELECT * FROM old` を足す。実行は呼び出し側 (App) が確定即クローズで
 * 既存の `run_query_transaction` に流す (RenameTableDialog / SaveAsTableModal と同じ流儀)。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string;
  sourceTable: string;
  onConfirm: (newName: string, statements: string[]) => void;
  onClose: () => void;
}

export function TableCloneModal({ sessionId, driver, database, sourceTable, onConfirm, onClose }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [includeData, setIncludeData] = useState(false);
  const [ddl, setDdl] = useState<string | null>(null);
  const [ddlError, setDdlError] = useState<string | null>(null);
  // INSERT ... SELECT の明示列リスト (生成列を除く)。列メタが取れなければ null = SELECT *。
  const [insertCols, setInsertCols] = useState<string[] | null>(null);
  // PostgreSQL のみ: 列種別 (identity/serial/生成) と外部キー定義 (pg_constraint)。
  const [pgMeta, setPgMeta] = useState<{ columns: PgColumnFlags; fks: PgForeignKey[] } | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [existingTables, setExistingTables] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getObjectDefinition(sessionId, database, "table", sourceTable)
      .then((d) => {
        if (!cancelled) setDdl(d);
      })
      .catch((e) => {
        if (!cancelled) setDdlError(String(e));
      });
    // 列メタ (生成列の除外用)。MySQL/SQLite は失敗しても複製自体は続ける (SELECT * に退避)。
    // PostgreSQL は identity/serial/FK を正しく写すのに必須なので、失敗したら確定させない。
    void (async () => {
      try {
        const cols = await api.describeTable(sessionId, database, sourceTable);
        let generated: string[] = [];
        if (driver === "postgres") {
          const lookup = (sql: string) => api.runLookupQuery({ sessionId, sql, database });
          const flags = parsePgColumnFlags((await lookup(buildPgColumnFlagsSql(database, sourceTable))).rows);
          const fks = parsePgForeignKeys((await lookup(buildPgForeignKeysSql(database, sourceTable))).rows);
          generated = flags.generated;
          if (!cancelled) setPgMeta({ columns: flags, fks });
        }
        if (!cancelled) setInsertCols(insertableColumns(driver, cols, generated));
      } catch (e) {
        if (!cancelled && driver === "postgres") setMetaError(String(e));
      }
    })();
    api
      .listTables(sessionId, database)
      .then((tables) => {
        if (!cancelled) setExistingTables(tables);
      })
      .catch((e) => {
        if (!cancelled) {
          // 一覧が取れなくても入力はブロックしない (衝突は DB 側のエラーとして表面化する)。
          setExistingTables([]);
          setListError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, sourceTable, driver]);

  // 既存テーブル名が分かった時点で、ユーザがまだ触っていなければ既定名 (<元>_copy) を入れる。
  useEffect(() => {
    if (existingTables && !nameTouched) setName(suggestCloneName(existingTables, sourceTable));
  }, [existingTables, nameTouched, sourceTable]);

  const trimmed = name.trim();
  const loading = existingTables === null || (ddl === null && ddlError === null);
  const collides = existingTables ? tableNameCollides(existingTables, trimmed) : false;

  // 名前が空でも「テーブルとして複製できる DDL か」を判定するため仮名で組み立てる。
  const result = useMemo(
    () =>
      ddl
        ? buildCloneStatements({
            driver,
            database,
            sourceTable,
            newTable: trimmed || `${sourceTable}_copy`,
            ddl,
            includeData,
            columns: insertCols,
            pgColumns: pgMeta?.columns ?? null,
            pgForeignKeys: pgMeta?.fks ?? null,
          })
        : null,
    [ddl, trimmed, driver, database, sourceTable, includeData, insertCols, pgMeta],
  );
  // PG は列種別/FK を取り終えるまで文が確定しない (不完全なプレビューや注意を出さない)。
  const metaPending = driver === "postgres" && !pgMeta && !metaError;
  const statements = trimmed && !metaPending ? (result?.statements ?? []) : [];
  const notTable = !metaPending && !!result && result.statements.length === 0 && result.errors.length === 0;
  const valid = !loading && !metaPending && !metaError && !collides && trimmed.length > 0 && statements.length > 0;

  const submit = () => {
    if (valid) onConfirm(trimmed, statements);
  };

  return (
    <Modal onSubmit={submit} submitDisabled={!valid} width="600px" onClose={onClose} initialFocusEl={() => inputRef.current}>
      <ModalHeader onClose={onClose} closeLabel={t("cloneTableClose")}>
        {t("cloneTableTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <FormSection>
          <FieldLabel htmlFor="clone-table-name">{t("cloneTableNameLabel", { table: sourceTable })}</FieldLabel>
          <Flex align="center" gap="2">
            <Input
              id="clone-table-name"
              ref={inputRef}
              value={name}
              onChange={(e) => {
                setNameTouched(true);
                setName(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              flex="1"
            />
            {loading && <Spinner size={14} />}
          </Flex>
          {trimmed.length > 0 && collides && (
            <FieldError>{t("cloneTableNameExists", { table: trimmed })}</FieldError>
          )}
          {listError && (
            <chakra.span textStyle="caption">{t("cloneTableListError", { error: listError })}</chakra.span>
          )}
        </FormSection>

        <Switch checked={includeData} onChange={setIncludeData} label={t("cloneTableIncludeData")} />

        {ddlError && <ErrorNote>{t("cloneTableDdlError", { error: ddlError })}</ErrorNote>}
        {metaError && <ErrorNote>{t("cloneTableMetaError", { error: metaError })}</ErrorNote>}
        {notTable && <ErrorNote>{t("cloneTableNotTable")}</ErrorNote>}
        {result && result.errors.length > 0 && (
          <ErrorNote>{t("cloneTableRewriteError", { statements: result.errors.join(" / ") })}</ErrorNote>
        )}
        {!metaPending && result?.sharedSequence && <Callout tone="warning">{t("cloneTableSharedSequence")}</Callout>}
        {result && result.skipped.length > 0 && (
          <Callout tone="warning">{t("cloneTableSkipped", { statements: result.skipped.join(" / ") })}</Callout>
        )}

        <FormSection>
          <FieldLabel as="div">{t("cloneTablePreview")}</FieldLabel>
          <CodePreview minH="120px">
            {metaPending ? t("cloneTablePreviewLoading") : statements.length > 0 ? formatCloneStatements(statements) : t("cloneTablePreviewEmpty")}
          </CodePreview>
          <chakra.span textStyle="caption">{t("cloneTableNotes")}</chakra.span>
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("cloneTableClose")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!valid} onClick={submit}>
          {t("cloneTableConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
