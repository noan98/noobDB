import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { Checkbox, Button, Input, Select } from "./ui";
import { FieldLabel } from "./modalForm";
import { Icon } from "./Icon";
import {
  REFERENTIAL_ACTIONS,
  emptyCheck,
  emptyForeignKey,
  type CheckDef,
  type ForeignKeyDef,
  type ReferentialAction,
} from "./tableConstraints";

/**
 * 外部キー / CHECK 制約の入力欄 (#1191)。CREATE TABLE ウィザードと ALTER TABLE
 * ダイアログで共有する。行の状態は呼び出し側が持ち (`id` は React key 用)、SQL 生成は
 * `tableConstraints.ts` / `createTable.ts` / `alterTable.ts` の純ロジックに任せる。
 */
export type FkRow = ForeignKeyDef & { id: string };
export type CheckRow = CheckDef & { id: string };

interface Props {
  foreignKeys: FkRow[];
  checks: CheckRow[];
  onForeignKeysChange: (rows: FkRow[]) => void;
  onChecksChange: (rows: CheckRow[]) => void;
  /** FK の子側に選べる列名。 */
  columnNames: string[];
  /** 参照先テーブルのサジェスト。 */
  tableNames: string[];
  nextId: () => string;
  /** true なら追加操作を無効化する (SQLite の ALTER など)。 */
  disabled?: boolean;
  /** 無効時に出す理由。 */
  disabledNote?: string;
  /** datalist の id (同一ページで一意)。 */
  idPrefix: string;
}

export function TableConstraintEditor({
  foreignKeys,
  checks,
  onForeignKeysChange,
  onChecksChange,
  columnNames,
  tableNames,
  nextId,
  disabled,
  disabledNote,
  idPrefix,
}: Props) {
  const t = useT();
  const tablesId = `${idPrefix}-tables`;
  const setFk = (i: number, patch: Partial<ForeignKeyDef>) =>
    onForeignKeysChange(foreignKeys.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const toggleFkColumn = (i: number, col: string) => {
    const r = foreignKeys[i];
    setFk(i, {
      columns: r.columns.includes(col) ? r.columns.filter((c) => c !== col) : [...r.columns, col],
    });
  };
  const setCheck = (i: number, patch: Partial<CheckDef>) =>
    onChecksChange(checks.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <chakra.div display="flex" flexDirection="column" gap="3">
      <datalist id={tablesId}>
        {tableNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {disabled && disabledNote && (
        <chakra.span fontSize="xs" color="app.textMuted">
          {disabledNote}
        </chakra.span>
      )}

      <chakra.div display="flex" flexDirection="column" gap="1.5">
        <FieldLabel as="div">{t("constraintFkSection")}</FieldLabel>
        {foreignKeys.map((fk, i) => (
          <chakra.div
            key={fk.id}
            display="flex"
            flexDirection="column"
            gap="1.5"
            p="2"
            borderWidth="1px"
            borderColor="app.border"
            borderRadius="lg"
          >
            <Flex gap="1.5" align="center" wrap="wrap">
              <Input
                value={fk.name}
                onChange={(e) => setFk(i, { name: e.target.value })}
                placeholder={t("constraintNamePlaceholder")}
                aria-label={t("constraintNamePlaceholder")}
                flex="1"
                minW="140px"
              />
              <Input
                value={fk.refTable}
                onChange={(e) => setFk(i, { refTable: e.target.value })}
                list={tablesId}
                placeholder={t("constraintFkRefTable")}
                aria-label={t("constraintFkRefTable")}
                flex="1"
                minW="140px"
              />
              <Input
                value={fk.refColumns.join(", ")}
                onChange={(e) =>
                  setFk(i, { refColumns: e.target.value.split(",").map((c) => c.trim()) })
                }
                placeholder={t("constraintFkRefColumns")}
                aria-label={t("constraintFkRefColumns")}
                flex="1"
                minW="140px"
              />
              <chakra.button
                type="button"
                onClick={() => onForeignKeysChange(foreignKeys.filter((_, idx) => idx !== i))}
                aria-label={t("constraintFkRemove")}
                color="app.textMuted"
                _hover={{ color: "app.textError" }}
                px="1"
              >
                <Icon name="close" />
              </chakra.button>
            </Flex>
            <Flex gap="3" wrap="wrap">
              {columnNames.length === 0 && (
                <chakra.span fontSize="xs" color="app.textMuted">
                  {t("treeNoColumns")}
                </chakra.span>
              )}
              {columnNames.map((col) => (
                <chakra.label key={col} display="flex" alignItems="center" gap="1" fontSize="sm">
                  <Checkbox checked={fk.columns.includes(col)} onChange={() => toggleFkColumn(i, col)} />
                  {col}
                </chakra.label>
              ))}
            </Flex>
            <Flex gap="3" wrap="wrap" align="center">
              <ActionSelect
                label="ON DELETE"
                value={fk.onDelete}
                onChange={(v) => setFk(i, { onDelete: v })}
              />
              <ActionSelect
                label="ON UPDATE"
                value={fk.onUpdate}
                onChange={(v) => setFk(i, { onUpdate: v })}
              />
            </Flex>
          </chakra.div>
        ))}
        <Flex>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || columnNames.length === 0}
            onClick={() => onForeignKeysChange([...foreignKeys, { id: nextId(), ...emptyForeignKey() }])}
          >
            <Icon name="plus" /> {t("constraintFkAdd")}
          </Button>
        </Flex>
      </chakra.div>

      <chakra.div display="flex" flexDirection="column" gap="1.5">
        <FieldLabel as="div">{t("constraintCheckSection")}</FieldLabel>
        {checks.map((ck, i) => (
          <Flex key={ck.id} gap="1.5" align="center">
            <Input
              value={ck.name}
              onChange={(e) => setCheck(i, { name: e.target.value })}
              placeholder={t("constraintNamePlaceholder")}
              aria-label={t("constraintNamePlaceholder")}
              flex="1"
            />
            <Input
              value={ck.expression}
              onChange={(e) => setCheck(i, { expression: e.target.value })}
              placeholder={t("constraintCheckExpr")}
              aria-label={t("constraintCheckExpr")}
              flex="2"
              fontFamily="mono"
            />
            <chakra.button
              type="button"
              onClick={() => onChecksChange(checks.filter((_, idx) => idx !== i))}
              aria-label={t("constraintCheckRemove")}
              color="app.textMuted"
              _hover={{ color: "app.textError" }}
              px="1"
            >
              <Icon name="close" />
            </chakra.button>
          </Flex>
        ))}
        <Flex>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled}
            onClick={() => onChecksChange([...checks, { id: nextId(), ...emptyCheck() }])}
          >
            <Icon name="plus" /> {t("constraintCheckAdd")}
          </Button>
        </Flex>
      </chakra.div>
    </chakra.div>
  );
}

function ActionSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ReferentialAction;
  onChange: (v: ReferentialAction) => void;
}) {
  const t = useT();
  return (
    <chakra.label display="flex" alignItems="center" gap="1.5" fontSize="sm">
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value as ReferentialAction)}>
        {REFERENTIAL_ACTIONS.map((a) => (
          <option key={a} value={a}>
            {a === "" ? t("constraintFkActionDefault") : a}
          </option>
        ))}
      </Select>
    </chakra.label>
  );
}
