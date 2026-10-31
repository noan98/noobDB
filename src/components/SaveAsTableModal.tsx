import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type DriverKind, type TableColumnInfo } from "../api/tauri";
import { useT } from "../i18n";
import {
  type AppendIssue,
  autoMapAppendColumns,
  buildCreateTableAsSql,
  buildInsertSelectSql,
  findAppendIssues,
  hasBlockingAppendIssue,
  tableNameCollides,
} from "./resultsToTable";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, FieldError, FieldLabel, FormSection } from "./modalForm";
import { isPlainEnterKey } from "./modalKeys";
import { Button, Input, PressableButton } from "./ui";
import { ListboxSelect } from "./ListboxSelect";
import { Spinner } from "./Spinner";

/**
 * 実行結果を新規テーブルへ保存 (CREATE TABLE ... AS SELECT、#821)。
 *
 * ソースクエリと対象データベースは呼び出し側 (App) が確定済みで渡し、ここでは
 * 新しいテーブル名だけを入力させる。既存テーブルと同じ名前を入れると追記モードへ
 * 切り替わり (#1623)、結果の列と追記先の列の対応を確認したうえで
 * `INSERT INTO ... SELECT` を実行する (`resultColumns` を渡されたときだけ。省略時は
 * 従来どおり名前の衝突でブロックする)。マウント時に `api.listTables` で既存テーブル名を
 * 取得し、入力中の名前が衝突していれば即時に警告して確定ボタンを無効化する
 * (ベストエフォート — 実際の作成は `onConfirm` が既存の DDL 実行経路へ委ねるので、
 * ここでの判定をすり抜けても DB 側のエラーとして表面化する)。SQL 生成/衝突判定の
 * 純ロジックは `resultsToTable.ts` に分離してテストする。CREATE TABLE ウィザード
 * (`CreateTableModal`) / テーブル名変更 (`RenameTableDialog`) と同じ、確定即クローズ
 * (実行は呼び出し側が非同期で担当) の流儀に揃える。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string;
  sourceSql: string;
  /** 結果セットの列名。渡すと既存テーブルへの追記モードが使える (#1623)。 */
  resultColumns?: string[];
  /** 読み取り専用接続では追記モードを使わない (従来どおり名前の衝突として扱う)。 */
  readOnly?: boolean;
  /** 追記モードのときは `appendSql` (INSERT ... SELECT) も渡る。 */
  onConfirm: (name: string, appendSql?: string) => void;
  onClose: () => void;
}

export function SaveAsTableModal({
  sessionId,
  driver,
  database,
  sourceSql,
  resultColumns,
  readOnly = false,
  onConfirm,
  onClose,
}: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [existingTables, setExistingTables] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [targetColumns, setTargetColumns] = useState<TableColumnInfo[] | null>(null);
  const [describeError, setDescribeError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<(string | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .listTables(sessionId, database)
      .then((tables) => {
        if (!cancelled) setExistingTables(tables);
      })
      .catch((e) => {
        if (!cancelled) {
          // 一覧取得に失敗しても入力自体はブロックしない — 衝突チェックが
          // 効かなくなるだけで、最終的には DB 側のエラーとして表面化する。
          setExistingTables([]);
          setListError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  const trimmed = name.trim();
  const loading = existingTables === null;
  const collides = existingTables ? tableNameCollides(existingTables, trimmed) : false;
  // 追記モード: 既存テーブルと同名で、結果の列名が分かっているとき。
  const appendTable =
    collides && resultColumns && !readOnly
      ? (existingTables?.find((x) => x.toLowerCase() === trimmed.toLowerCase()) ?? null)
      : null;
  const appendMode = appendTable !== null;

  useEffect(() => {
    if (!appendTable || !resultColumns) {
      setTargetColumns(null);
      setDescribeError(null);
      return;
    }
    let cancelled = false;
    setTargetColumns(null);
    setDescribeError(null);
    api
      .describeTable(sessionId, database, appendTable)
      .then((cols) => {
        if (cancelled) return;
        setTargetColumns(cols);
        setMapping(autoMapAppendColumns(resultColumns, cols));
      })
      .catch((e) => {
        if (!cancelled) setDescribeError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [appendTable, resultColumns, sessionId, database]);

  const issues: AppendIssue[] = useMemo(
    () =>
      appendMode && targetColumns && resultColumns
        ? findAppendIssues(resultColumns, mapping, targetColumns)
        : [],
    [appendMode, targetColumns, resultColumns, mapping],
  );
  const appendReady = appendMode && targetColumns !== null && !hasBlockingAppendIssue(issues);
  const appendSql = useMemo(
    () =>
      appendMode && targetColumns && resultColumns
        ? buildInsertSelectSql(driver, database, appendTable as string, resultColumns, mapping, sourceSql)
        : "",
    [appendMode, targetColumns, resultColumns, driver, database, appendTable, mapping, sourceSql],
  );
  const valid = trimmed.length > 0 && !loading && (appendMode ? appendReady : !collides);

  const createSql = useMemo(
    () => (trimmed ? buildCreateTableAsSql(driver, database, trimmed, sourceSql) : ""),
    [driver, database, trimmed, sourceSql],
  );
  const sql = appendMode ? appendSql : createSql;

  const submit = () => {
    if (!valid) return;
    if (appendMode) onConfirm(appendTable as string, appendSql);
    else onConfirm(trimmed);
  };

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={!valid}
      width="560px"
      onClose={onClose}
      initialFocusEl={() => inputRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("saveAsTableClose")}>
        {t("saveAsTableTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <FormSection>
          <FieldLabel htmlFor="save-as-table-name">{t("saveAsTableNameLabel")}</FieldLabel>
          <Flex align="center" gap="2">
            <Input
              id="save-as-table-name"
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("saveAsTableNamePlaceholder")}
              onKeyDown={(e) => {
                if (isPlainEnterKey(e)) submit();
              }}
              flex="1"
            />
            {loading && <Spinner size={14} />}
          </Flex>
          {trimmed.length > 0 && collides && appendMode && (
            <Callout tone="info">{t("saveAsTableAppendNotice", { table: appendTable as string })}</Callout>
          )}
          {trimmed.length > 0 && collides && !appendMode && (
            <FieldError>{t("saveAsTableNameExists", { table: trimmed })}</FieldError>
          )}
          {listError && (
            <chakra.span fontSize="xs" color="app.textMuted">
              {t("saveAsTableListError", { error: listError })}
            </chakra.span>
          )}
        </FormSection>

        {appendMode && resultColumns && (
          <FormSection>
            <FieldLabel as="div">{t("saveAsTableAppendMapping")}</FieldLabel>
            {describeError && (
              <FieldError>{t("saveAsTableAppendDescribeError", { error: describeError })}</FieldError>
            )}
            {targetColumns === null && !describeError && <Spinner size={14} />}
            {targetColumns && (
              <Flex direction="column" gap="2">
                {resultColumns.map((rc, i) => (
                  // 結果列名は重複しうるので位置を含めたキーにする。
                  <Flex key={`${i}:${rc}`} align="center" gap="2">
                    <chakra.span
                      flex="1"
                      fontSize="sm"
                      fontFamily="mono"
                      overflow="hidden"
                      textOverflow="ellipsis"
                    >
                      {rc}
                    </chakra.span>
                    <chakra.span color="app.textMuted" aria-hidden="true">
                      →
                    </chakra.span>
                    <ListboxSelect
                      css={{ flex: 1, minWidth: 0 }}
                      ariaLabel={t("saveAsTableAppendTargetAria", { column: rc })}
                      value={mapping[i] ?? ""}
                      options={[
                        { value: "", label: t("saveAsTableAppendSkip") },
                        ...targetColumns.map((c) => ({ value: c.name })),
                      ]}
                      onChange={(v) => setMapping((prev) => prev.map((m, j) => (j === i ? v || null : m)))}
                    />
                  </Flex>
                ))}
              </Flex>
            )}
            {issues.map((issue) => (
              <FieldError key={`${issue.kind}:${"column" in issue ? issue.column : ""}`}>
                {issue.kind === "noneMapped"
                  ? t("saveAsTableAppendNoneMapped")
                  : issue.kind === "duplicateTarget"
                    ? t("saveAsTableAppendDuplicateTarget", { column: issue.column })
                    : issue.kind === "duplicateSource"
                      ? t("saveAsTableAppendDuplicateSource", { column: issue.column })
                      : t("saveAsTableAppendMissingRequired", { column: issue.column })}
              </FieldError>
            ))}
          </FormSection>
        )}

        <FormSection>
          <FieldLabel as="div">{t("saveAsTablePreview")}</FieldLabel>
          <CodePreview minH="60px">{sql || t("saveAsTablePreviewEmpty")}</CodePreview>
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("saveAsTableClose")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!valid} onClick={submit}>
          {appendMode ? t("saveAsTableAppendConfirm") : t("saveAsTableConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
