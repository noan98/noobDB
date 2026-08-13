import { useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { api, type DriverKind, type TableColumnInfo } from "../api/tauri";
import { buildCreateIndexSql } from "./tableMaintenance";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Input, PressableButton, Switch } from "./ui";

/**
 * インデックス作成の軽量モーダル (#850)。`describeTable` で列一覧を取得し、選択した
 * 列 + UNIQUE + 任意のインデックス名から `CREATE INDEX` 文を生成・プレビューして
 * 実行する。SQL 生成の純ロジックは `tableMaintenance.ts` の `buildCreateIndexSql`
 * (方言分岐はバックエンドの `db/advisor.rs::create_index_ddl` の移植で、アドバイザの
 * 自動修正 DDL と同じ命名規則を使う)。
 *
 * 列編集ダイアログ (`AlterTableModal`、#794) にもインデックス追加のフォームが
 * 含まれるが、あちらは既存列の一覧・追加・削除まで一式を読み込む重量な画面。
 * こちらはテーブル右クリックから直接開ける単一目的の近道で、`CreateTableModal` と
 * 同じ「軽量モーダル + プレビュー」の流儀を踏襲する (二重実装ではなく、
 * `SaveAsTableModal` のように既存の重量フォームと共存する専用の近道)。
 *
 * read_only セッションでは実行ボタンを無効化する (バックエンドも write を拒否する)。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string | null;
  table: string;
  readOnly: boolean;
  onRun: (sql: string) => void;
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

export function CreateIndexModal({
  sessionId,
  driver,
  database,
  table,
  readOnly,
  onRun,
  onSendToEditor,
  onClose,
}: Props) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .describeTable(sessionId, database ?? "", table)
      .then((cols: TableColumnInfo[]) => {
        if (cancelled) return;
        setColumns(cols.map((c) => c.name));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table]);

  const toggleColumn = (col: string) =>
    setSelected((cols) => (cols.includes(col) ? cols.filter((c) => c !== col) : [...cols, col]));

  const valid = selected.length > 0;
  const sql = useMemo(
    () => (valid ? buildCreateIndexSql(driver, database, table, selected, { name, unique }) : ""),
    [valid, driver, database, table, selected, name, unique],
  );

  return (
    <Modal width="520px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("createTableClose")}>
        {t("createIndexTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {loading && (
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("alterTableLoading")}
          </chakra.span>
        )}
        {loadError && (
          <chakra.span fontSize="sm" color="app.dangerFg">
            {t("alterTableLoadError", { error: loadError })}
          </chakra.span>
        )}
        {!loading && !loadError && (
          <>
            <Flex align="center" gap="2">
              <chakra.label fontSize="sm" color="app.textSecondary" minW="90px">
                {t("createIndexName")}
              </chakra.label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("createIndexNamePlaceholder")}
                flex="1"
              />
            </Flex>
            <Switch checked={unique} onChange={() => setUnique(!unique)} label={t("createTableColUnique")} />
            <chakra.div display="flex" flexDirection="column" gap="1.5">
              <chakra.span fontSize="xs" fontWeight="600" color="app.textMuted">
                {t("createIndexColumns")}
              </chakra.span>
              <Flex gap="3" wrap="wrap">
                {columns.length === 0 && (
                  <chakra.span fontSize="xs" color="app.textMuted">
                    {t("treeNoColumns")}
                  </chakra.span>
                )}
                {columns.map((col) => (
                  <chakra.label key={col} display="flex" alignItems="center" gap="1" fontSize="sm">
                    <Checkbox checked={selected.includes(col)} onChange={() => toggleColumn(col)} />
                    {col}
                  </chakra.label>
                ))}
              </Flex>
            </chakra.div>
            <chakra.div display="flex" flexDirection="column" gap="1">
              <chakra.span fontSize="xs" color="app.textMuted">
                {t("createTablePreview")}
              </chakra.span>
              <chakra.pre
                fontFamily="mono"
                fontSize="sm"
                bg="app.surface"
                borderWidth="1px"
                borderColor="app.border"
                borderRadius="8px"
                p="2.5"
                overflowX="auto"
                whiteSpace="pre"
                color="app.text"
                minH="48px"
              >
                {sql || t("createIndexPreviewEmpty")}
              </chakra.pre>
            </chakra.div>
            {readOnly && (
              <chakra.span fontSize="xs" color="app.dangerFg">
                {t("createTableReadOnly")}
              </chakra.span>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("createTableClose")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" disabled={!valid} onClick={() => onSendToEditor(sql)}>
          {t("createTableToEditor")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!valid || readOnly} onClick={() => onRun(sql)}>
          {t("createIndexRun")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
