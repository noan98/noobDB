import { useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { DriverKind } from "../api/tauri";
import { buildCreateTableSql, type ColumnDef } from "./createTable";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, PressableButton, Switch } from "./ui";
import { Icon } from "./Icon";

/**
 * CREATE TABLE ウィザード。カラム定義をフォームで組み立て、方言に応じた
 * CREATE TABLE 文を生成・プレビューして実行 (またはエディタへ転送) する。SQL 生成の
 * 純ロジックは `createTable.ts`、識別子/リテラルのエスケープは sqlDialect/cellEdit を流用。
 * read_only セッションでは実行ボタンを無効化する (バックエンドも write を拒否する)。
 */
interface Props {
  driver: DriverKind;
  database: string | null;
  readOnly: boolean;
  onRun: (sql: string) => void;
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

/** ドライバ別の型サジェスト (datalist 用)。 */
const TYPE_SUGGESTIONS: Record<DriverKind, string[]> = {
  mysql: ["INT", "BIGINT", "VARCHAR(255)", "TEXT", "DATETIME", "DATE", "DECIMAL(10,2)", "BOOLEAN", "JSON"],
  postgres: ["INTEGER", "BIGINT", "VARCHAR(255)", "TEXT", "TIMESTAMPTZ", "DATE", "NUMERIC(10,2)", "BOOLEAN", "JSONB", "UUID"],
  sqlite: ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"],
};

function emptyColumn(driver: DriverKind): ColumnDef {
  return {
    name: "",
    type: driver === "sqlite" ? "TEXT" : "VARCHAR(255)",
    notNull: false,
    primaryKey: false,
    unique: false,
    autoIncrement: false,
    defaultValue: "",
  };
}

export function CreateTableModal({ driver, database, readOnly, onRun, onSendToEditor, onClose }: Props) {
  const t = useT();
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<ColumnDef[]>(() => [
    { name: "id", type: driver === "sqlite" ? "INTEGER" : "INT", notNull: true, primaryKey: true, unique: false, autoIncrement: true, defaultValue: "" },
  ]);

  const setCol = (i: number, patch: Partial<ColumnDef>) =>
    setColumns((cols) => cols.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCol = () => setColumns((cols) => [...cols, emptyColumn(driver)]);
  const removeCol = (i: number) => setColumns((cols) => cols.filter((_, idx) => idx !== i));

  const valid = table.trim().length > 0 && columns.length > 0 && columns.every((c) => c.name.trim().length > 0);
  const sql = useMemo(
    () => (valid ? buildCreateTableSql(driver, { database, table: table.trim(), columns }) : ""),
    [valid, driver, database, table, columns],
  );

  const dataListId = "create-table-types";

  return (
    <Modal width="820px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("createTableClose")}>
        {t("createTableTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <Flex align="center" gap="2">
          <chakra.label fontSize="sm" color="app.textSecondary" minW="90px">
            {t("createTableName")}
          </chakra.label>
          <Input
            value={table}
            onChange={(e) => setTable(e.target.value)}
            placeholder={t("createTableNamePlaceholder")}
            flex="1"
          />
        </Flex>

        <datalist id={dataListId}>
          {TYPE_SUGGESTIONS[driver].map((ty) => (
            <option key={ty} value={ty} />
          ))}
        </datalist>

        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <chakra.div display="grid" gridTemplateColumns="1.3fr 1.3fr repeat(4, auto) 1.2fr auto" gap="1.5" fontSize="xs" color="app.textMuted" px="0.5">
            <span>{t("createTableColName")}</span>
            <span>{t("createTableColType")}</span>
            <span>{t("createTableColNotNull")}</span>
            <span>PK</span>
            <span>{t("createTableColUnique")}</span>
            <span>{t("createTableColAuto")}</span>
            <span>{t("createTableColDefault")}</span>
            <span />
          </chakra.div>
          {columns.map((c, i) => (
            <chakra.div key={i} display="grid" gridTemplateColumns="1.3fr 1.3fr repeat(4, auto) 1.2fr auto" gap="1.5" alignItems="center">
              <Input value={c.name} onChange={(e) => setCol(i, { name: e.target.value })} placeholder="column" />
              <Input value={c.type} onChange={(e) => setCol(i, { type: e.target.value })} list={dataListId} />
              <Switch checked={c.notNull} onChange={() => setCol(i, { notNull: !c.notNull })} />
              <Switch checked={c.primaryKey} onChange={() => setCol(i, { primaryKey: !c.primaryKey })} />
              <Switch checked={c.unique} onChange={() => setCol(i, { unique: !c.unique })} />
              <Switch checked={c.autoIncrement} onChange={() => setCol(i, { autoIncrement: !c.autoIncrement })} />
              <Input value={c.defaultValue} onChange={(e) => setCol(i, { defaultValue: e.target.value })} placeholder={t("createTableColDefault")} />
              <chakra.button
                type="button"
                onClick={() => removeCol(i)}
                aria-label={t("createTableRemoveCol")}
                title={t("createTableRemoveCol")}
                color="app.textMuted"
                _hover={{ color: "app.dangerFg" }}
                disabled={columns.length <= 1}
                px="1"
              >
                <Icon name="close" />
              </chakra.button>
            </chakra.div>
          ))}
          <Flex>
            <Button type="button" variant="secondary" size="sm" onClick={addCol}>
              <Icon name="plus" /> {t("createTableAddCol")}
            </Button>
          </Flex>
        </chakra.div>

        <chakra.div display="flex" flexDirection="column" gap="1">
          <chakra.span fontSize="xs" color="app.textMuted">{t("createTablePreview")}</chakra.span>
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
            minH="60px"
          >
            {sql || t("createTablePreviewEmpty")}
          </chakra.pre>
        </chakra.div>
        {readOnly && (
          <chakra.span fontSize="xs" color="app.dangerFg">{t("createTableReadOnly")}</chakra.span>
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
          {t("createTableRun")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
