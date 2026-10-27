import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { api, type DriverKind } from "../api/tauri";
import {
  buildCreateTableSql,
  columnDefsFromTableInfo,
  generatedColumnProblems,
  supportsVirtualGenerated,
  templateCaveats,
  type ColumnDef,
  type TemplateCaveats,
} from "./createTable";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton, Select, Switch } from "./ui";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { TableConstraintEditor, type CheckRow, type FkRow } from "./TableConstraintEditor";
import { isCompleteCheck, isCompleteForeignKey, isPartialForeignKey } from "./tableConstraints";

/**
 * CREATE TABLE ウィザード。カラム定義をフォームで組み立て、方言に応じた
 * CREATE TABLE 文を生成・プレビューして実行 (またはエディタへ転送) する。SQL 生成の
 * 純ロジックは `createTable.ts`、識別子/リテラルのエスケープは sqlDialect/cellEdit を流用。
 * read_only セッションでは実行ボタンを無効化する (バックエンドも write を拒否する)。
 */
interface Props {
  /** 参照先テーブルのサジェスト取得用 (省略時はサジェストなし)。 */
  sessionId?: string;
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
  postgres: [
    "INTEGER",
    "BIGINT",
    "VARCHAR(255)",
    "TEXT",
    "TIMESTAMPTZ",
    "DATE",
    "NUMERIC(10,2)",
    "BOOLEAN",
    "JSONB",
    "UUID",
  ],
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

/** 開いた直後の初期列 (id 1 本) のまま変更されていないか。 */
function isInitialColumn(c: ColumnDef, driver: DriverKind): boolean {
  return (
    c.name === "id" &&
    c.type === (driver === "sqlite" ? "INTEGER" : "INT") &&
    c.notNull &&
    c.primaryKey &&
    !c.unique &&
    c.autoIncrement &&
    c.defaultValue === ""
  );
}

export function CreateTableModal({
  sessionId,
  driver,
  database,
  readOnly,
  onRun,
  onSendToEditor,
  onClose,
}: Props) {
  const t = useT();
  const [table, setTable] = useState("");
  const [columns, setColumns] = useState<ColumnDef[]>(() => [
    {
      name: "id",
      type: driver === "sqlite" ? "INTEGER" : "INT",
      notNull: true,
      primaryKey: true,
      unique: false,
      autoIncrement: true,
      defaultValue: "",
    },
  ]);

  const [foreignKeys, setForeignKeys] = useState<FkRow[]>([]);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [tableNames, setTableNames] = useState<string[]>([]);
  const rowIdCounter = useRef(0);
  const nextRowId = () => `row${++rowIdCounter.current}`;

  useEffect(() => {
    if (!sessionId || !database) return;
    let cancelled = false;
    api
      .listTables(sessionId, database)
      .then((names) => {
        if (!cancelled) setTableNames(names);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  // 既存テーブルの列定義を雛形として読み込む (#1540)。
  const [templateTable, setTemplateTable] = useState("");
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [caveats, setTemplateCaveats] = useState<TemplateCaveats | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const loadTemplate = async () => {
    if (!sessionId || !database || !templateTable) return;
    setTemplateLoading(true);
    setTemplateError(null);
    setTemplateCaveats(null);
    try {
      const info = await api.describeTable(sessionId, database, templateTable);
      if (info.length === 0) {
        setTemplateError(t("createTableTemplateEmpty", { table: templateTable }));
        return;
      }
      // 入力済みの列 (名前が入っている / 初期の id 以外) があるときだけ、置き換えを確認する。
      const initial = columns.length === 1 && isInitialColumn(columns[0], driver);
      const hasInput = !initial || foreignKeys.length > 0 || checks.length > 0;
      if (hasInput) {
        const ok = await confirm({
          title: t("createTableTemplateConfirmTitle"),
          message: t("createTableTemplateConfirmBody", { table: templateTable }),
          confirmLabel: t("createTableTemplateLoad"),
          tone: "warning",
        });
        if (!ok) return;
      }
      setColumns(columnDefsFromTableInfo(info));
      setTemplateCaveats(templateCaveats(driver, info));
      // 空のままなら、元の名前に _copy を付けた名前を提案する (上書きはしない)。
      setTable((cur) => (cur.trim() === "" ? `${templateTable}_copy` : cur));
      // 元テーブルの制約は引き継がないので、既に入力済みの制約は列名と食い違いうる → 破棄する。
      setForeignKeys([]);
      setChecks([]);
    } catch (e) {
      setTemplateError(t("createTableTemplateError", { error: String(e) }));
      setTemplateCaveats(null);
    } finally {
      setTemplateLoading(false);
    }
  };

  const setCol = (i: number, patch: Partial<ColumnDef>) =>
    setColumns((cols) => cols.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const addCol = () => setColumns((cols) => [...cols, emptyColumn(driver)]);
  // 生成列にすると DEFAULT・自動採番・主キーは併用できないので外す (#1893)。
  const toggleGenerated = (i: number) =>
    setColumns((cols) =>
      cols.map((c, idx) => {
        if (idx !== i) return c;
        if (c.generated) {
          const { generated: _g, ...rest } = c;
          return rest;
        }
        return {
          ...c,
          primaryKey: false,
          autoIncrement: false,
          defaultValue: "",
          generated: { expression: "", virtual: supportsVirtualGenerated(driver) },
        };
      }),
    );
  const removeCol = (i: number) => setColumns((cols) => cols.filter((_, idx) => idx !== i));

  // 途中まで入力した FK 行は SQL 生成で黙って捨てられるので、直すまで実行を止める (#1602)。
  const hasPartialForeignKey = foreignKeys.some(isPartialForeignKey);
  // 生成列の式の不備・PostgreSQL の VIRTUAL は直すまで実行を止める (#1893)。
  const generatedErrors = columns.flatMap((c, i) =>
    generatedColumnProblems(driver, c)
      .filter((p) => p === "emptyExpression" || p === "invalidExpression" || p === "virtualUnsupported")
      .map((p) => ({ index: i, problem: p, name: c.name.trim() || `#${i + 1}` })),
  );
  const valid =
    table.trim().length > 0 &&
    columns.length > 0 &&
    columns.every((c) => c.name.trim().length > 0) &&
    !hasPartialForeignKey &&
    generatedErrors.length === 0;
  const sql = useMemo(
    () =>
      valid
        ? buildCreateTableSql(driver, {
            database,
            table: table.trim(),
            // 列名の前後空白は検証側 (trim 済み) と制約エディタ候補に合わせて落とす。
            columns: columns.map((c) => ({ ...c, name: c.name.trim() })),
            // id は React key 専用のローカル state なので純ロジックへ渡す前に落とす。
            foreignKeys: foreignKeys.filter(isCompleteForeignKey).map(({ id: _id, ...fk }) => fk),
            checks: checks.filter(isCompleteCheck).map(({ id: _id, ...ck }) => ck),
          })
        : "",
    [valid, driver, database, table, columns, foreignKeys, checks],
  );
  const columnNames = useMemo(
    () => [...new Set(columns.map((c) => c.name.trim()).filter((n) => n.length > 0))],
    [columns],
  );

  const dataListId = "create-table-types";

  return (
    <Modal onSubmit={() => onRun(sql)} submitDisabled={!valid || readOnly} width="820px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("createTableClose")}>
        {t("createTableTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <Flex align="center" gap="2">
          <FieldLabel htmlFor="create-table-name" minW="90px">
            {t("createTableName")}
          </FieldLabel>
          <Input
            id="create-table-name"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            placeholder={t("createTableNamePlaceholder")}
            flex="1"
          />
        </Flex>

        {sessionId && database && tableNames.length > 0 && (
          <FormSection>
            <Flex align="center" gap="2">
              <FieldLabel htmlFor="create-table-template" minW="90px">
                {t("createTableTemplate")}
              </FieldLabel>
              <Select
                id="create-table-template"
                value={templateTable}
                onChange={(e) => setTemplateTable(e.target.value)}
                flex="1"
              >
                <option value="">{t("createTableTemplateNone")}</option>
                {tableNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="secondary"
                disabled={!templateTable || templateLoading}
                onClick={() => void loadTemplate()}
              >
                {t("createTableTemplateLoad")}
              </Button>
            </Flex>
            <chakra.div textStyle="caption">{t("createTableTemplateHelp")}</chakra.div>
            {templateError && <FieldError>{templateError}</FieldError>}
            {caveats && caveats.userDefined.length > 0 && (
              <Callout tone="warning" role="status">
                {t("createTableTemplateUserDefined", { columns: caveats.userDefined.join(", ") })}
              </Callout>
            )}
            {caveats && caveats.arrays.length > 0 && (
              <Callout tone="warning" role="status">
                {t("createTableTemplateArray", { columns: caveats.arrays.join(", ") })}
              </Callout>
            )}
            {caveats && caveats.identityMaybe.length > 0 && (
              <Callout tone="info" role="status">
                {t("createTableTemplateIdentity", { columns: caveats.identityMaybe.join(", ") })}
              </Callout>
            )}
          </FormSection>
        )}

        <datalist id={dataListId}>
          {TYPE_SUGGESTIONS[driver].map((ty) => (
            <option key={ty} value={ty} />
          ))}
        </datalist>

        <chakra.div display="flex" flexDirection="column" gap="1.5">
          <chakra.div
            display="grid"
            gridTemplateColumns="1.3fr 1.3fr repeat(5, auto) 1.2fr auto"
            gap="1.5"
            textStyle="overline"
            px="0.5"
          >
            <span>{t("createTableColName")}</span>
            <span>{t("createTableColType")}</span>
            <span>{t("createTableColNotNull")}</span>
            <span>{t("createTableColPk")}</span>
            <span>{t("createTableColUnique")}</span>
            <span>{t("createTableColAuto")}</span>
            <span>{t("createTableColGenerated")}</span>
            <span>{t("createTableColDefault")}</span>
            <span />
          </chakra.div>
          {columns.map((c, i) => (
            <chakra.div key={i} display="flex" flexDirection="column" gap="1">
              <chakra.div
                display="grid"
                gridTemplateColumns="1.3fr 1.3fr repeat(5, auto) 1.2fr auto"
                gap="1.5"
                alignItems="center"
              >
                <Input
                  value={c.name}
                  onChange={(e) => setCol(i, { name: e.target.value })}
                  placeholder={t("createTableColNamePlaceholder")}
                  aria-label={`${t("createTableColName")} (${i + 1})`}
                />
                <Input
                  value={c.type}
                  onChange={(e) => setCol(i, { type: e.target.value })}
                  list={dataListId}
                  aria-label={`${t("createTableColType")} (${i + 1})`}
                />
                <Switch
                  checked={c.notNull}
                  onChange={() => setCol(i, { notNull: !c.notNull })}
                  aria-label={`${t("createTableColNotNull")} (${i + 1})`}
                />
                <Switch
                  checked={c.primaryKey}
                  disabled={!!c.generated}
                  onChange={() => setCol(i, { primaryKey: !c.primaryKey })}
                  aria-label={`${t("createTableColPk")} (${i + 1})`}
                />
                <Switch
                  checked={c.unique}
                  onChange={() => setCol(i, { unique: !c.unique })}
                  aria-label={`${t("createTableColUnique")} (${i + 1})`}
                />
                <Switch
                  checked={c.autoIncrement}
                  disabled={!!c.generated}
                  onChange={() => setCol(i, { autoIncrement: !c.autoIncrement })}
                  aria-label={`${t("createTableColAuto")} (${i + 1})`}
                />
                <Switch
                  checked={!!c.generated}
                  onChange={() => toggleGenerated(i)}
                  aria-label={`${t("createTableColGenerated")} (${i + 1})`}
                />
                <Input
                  value={c.defaultValue}
                  onChange={(e) => setCol(i, { defaultValue: e.target.value })}
                  disabled={!!c.generated}
                  placeholder={t("createTableColDefault")}
                  aria-label={`${t("createTableColDefault")} (${i + 1})`}
                />
                <Tooltip label={t("createTableRemoveCol")} focusableWrapper={columns.length <= 1}>
                  <chakra.button
                    type="button"
                    onClick={() => removeCol(i)}
                    aria-label={t("createTableRemoveCol")}
                    color="app.textMuted"
                    _hover={{ color: "app.textError" }}
                    disabled={columns.length <= 1}
                    px="1"
                  >
                    <Icon name="close" />
                  </chakra.button>
                </Tooltip>
              </chakra.div>
              {c.generated && (
                <Flex gap="1.5" align="center" pl="2">
                  <Input
                    value={c.generated.expression}
                    onChange={(e) =>
                      setCol(i, {
                        generated: { ...(c.generated ?? { virtual: false }), expression: e.target.value },
                      })
                    }
                    placeholder={t("createTableGeneratedExprPlaceholder")}
                    aria-label={`${t("createTableGeneratedExpr")} (${i + 1})`}
                    fontFamily="mono"
                    flex="1"
                  />
                  <Select
                    value={c.generated.virtual ? "virtual" : "stored"}
                    onChange={(e) =>
                      setCol(i, {
                        generated: {
                          expression: c.generated?.expression ?? "",
                          virtual: e.target.value === "virtual",
                        },
                      })
                    }
                    aria-label={`${t("createTableGeneratedStorage")} (${i + 1})`}
                    w="auto"
                  >
                    <option value="stored">{t("createTableGeneratedStored")}</option>
                    <option value="virtual" disabled={!supportsVirtualGenerated(driver)}>
                      {t("createTableGeneratedVirtual")}
                    </option>
                  </Select>
                </Flex>
              )}
            </chakra.div>
          ))}
          {columns.some((c) => c.generated) && (
            <chakra.div textStyle="caption">
              {t("createTableGeneratedExclusive")}
              {!supportsVirtualGenerated(driver) && ` ${t("createTableGeneratedPgNoVirtual")}`}
            </chakra.div>
          )}
          <Flex>
            <Button type="button" variant="secondary" size="sm" onClick={addCol}>
              <Icon name="plus" /> {t("createTableAddCol")}
            </Button>
          </Flex>
        </chakra.div>

        <TableConstraintEditor
          idPrefix="create-table"
          foreignKeys={foreignKeys}
          checks={checks}
          onForeignKeysChange={setForeignKeys}
          onChecksChange={setChecks}
          columnNames={columnNames}
          tableNames={tableNames}
          nextId={nextRowId}
        />

        <FormSection>
          <FieldLabel as="div">{t("createTablePreview")}</FieldLabel>
          <CodePreview minH="60px">{sql || t("createTablePreviewEmpty")}</CodePreview>
        </FormSection>
        {generatedErrors.map((g) => (
          <FieldError key={`${g.index}:${g.problem}`}>
            {g.problem === "invalidExpression"
              ? t("createTableGeneratedInvalid", { column: g.name })
              : g.problem === "virtualUnsupported"
                ? t("createTableGeneratedPgNoVirtual")
                : t("createTableGeneratedEmpty", { column: g.name })}
          </FieldError>
        ))}
        {hasPartialForeignKey && <FieldError>{t("createTableForeignKeyIncomplete")}</FieldError>}
        {readOnly && <FieldError>{t("createTableReadOnly")}</FieldError>}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" disabled={!valid} onClick={() => onSendToEditor(sql)}>
          {t("createTableToEditor")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("createTableClose")}
        </Button>
        <PressableButton
          type="button"
          variant="primary"
          disabled={!valid || readOnly}
          onClick={() => onRun(sql)}
        >
          {t("createTableRun")}
        </PressableButton>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}
