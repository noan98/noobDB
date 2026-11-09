import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { api, type DriverKind } from "../api/tauri";
import {
  buildCreateTableStatements,
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
import { SqlPreview } from "./SqlPreview";
import { FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton, Switch } from "./ui";
import { ListboxSelect } from "./ListboxSelect";
import { Icon } from "./Icon";
import { LiveRow, LiveRowsPresence } from "./LiveRows";
import { Tooltip } from "./Tooltip";
import { TableConstraintEditor, type CheckRow, type FkRow } from "./TableConstraintEditor";
import { isCompleteCheck, isCompleteForeignKey, isPartialForeignKey } from "./tableConstraints";
import {
  emptyPartitionSpec,
  emptyTableOptions,
  hasTableOptions,
  partitionMethods,
  tableOptionProblems,
  type PartitionMethod,
  type PartitionSpec,
  type TableOptionProblem,
  type TableOptions,
} from "./tableOptions";

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
  /** `statements` は文ごとの配列。複数文のときは呼び出し側がトランザクションで流す (#2161)。 */
  onRun: (sql: string, statements: string[], table: string) => void;
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

/** 列の並び (名前 / 型 / トグル 5 つ / 既定値 / 削除)。見出しと各行で同じ幅にして列をそろえる。 */
const COLUMN_GRID = "minmax(0, 1.3fr) minmax(0, 1.3fr) repeat(5, 4.5em) minmax(0, 1.2fr) 2em";

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
  // テーブルオプション (#2161): ENGINE / UNLOGGED / STRICT / パーティションなど。
  const [options, setOptions] = useState<TableOptions>(emptyTableOptions);
  const [tableNames, setTableNames] = useState<string[]>([]);
  const rowIdCounter = useRef(0);
  const nextRowId = () => `row${++rowIdCounter.current}`;
  // 列ごとの安定キー (`columns` と同じ並び)。添字キーだと途中の列を消したときに
  // 出入りアニメの対象がずれるため、列行ごとに ID を持たせる (#2014)。
  const [colKeys, setColKeys] = useState<string[]>(() => ["col0"]);
  const colKeysRef = useRef(colKeys);
  colKeysRef.current = colKeys;
  const nextColKey = () => `col${++rowIdCounter.current}`;

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
      const defs = columnDefsFromTableInfo(info);
      setColumns(defs);
      setColKeys(defs.map(() => nextColKey()));
      // 列を入れ替えたので、生成式の「触った行」の記録も捨てる (古い行番号が新しい列に当たらないように)。
      setGenTouched([]);
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
  const addCol = () => {
    setColumns((cols) => [...cols, emptyColumn(driver)]);
    setColKeys((ks) => [...ks, nextColKey()]);
  };
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
  // 退場アニメ中の行の × は古い添字を握っているので、キーで現在の位置を引き直す
  // (既に消えた行なら何もしない)。
  const removeCol = (key: string) => {
    const i = colKeysRef.current.indexOf(key);
    if (i < 0) return;
    setColumns((cols) => cols.filter((_, idx) => idx !== i));
    setColKeys((ks) => ks.filter((_, idx) => idx !== i));
    setGenTouched((cur) => cur.filter((n) => n !== i).map((n) => (n > i ? n - 1 : n)));
  };
  // 生成式の欄を触った行。空の式のエラーは触った後に出す (スイッチを入れた直後は伏せる)。
  const [genTouched, setGenTouched] = useState<number[]>([]);
  const touchGen = (i: number) => setGenTouched((cur) => (cur.includes(i) ? cur : [...cur, i]));

  // 途中まで入力した FK 行は SQL 生成で黙って捨てられるので、直すまで実行を止める (#1602)。
  const hasPartialForeignKey = foreignKeys.some(isPartialForeignKey);
  // 生成列の式の不備・PostgreSQL の VIRTUAL は直すまで実行を止める (#1893)。
  const generatedErrors = columns.flatMap((c, i) =>
    generatedColumnProblems(driver, c)
      .filter((p) => p === "emptyExpression" || p === "invalidExpression" || p === "virtualUnsupported")
      .map((p) => ({ index: i, problem: p, name: c.name.trim() || `#${i + 1}` })),
  );
  // テーブルオプションの不備。列名が空の列はキー・型の検査から外れるので、列名の不備と同時に直せる。
  const optionProblems = useMemo(
    () => tableOptionProblems(driver, columns, options, foreignKeys.filter(isCompleteForeignKey)),
    [driver, columns, options, foreignKeys],
  );
  const valid =
    table.trim().length > 0 &&
    columns.length > 0 &&
    columns.every((c) => c.name.trim().length > 0) &&
    !hasPartialForeignKey &&
    generatedErrors.length === 0 &&
    optionProblems.length === 0;
  const statements = useMemo(
    () =>
      valid
        ? buildCreateTableStatements(driver, {
            database,
            table: table.trim(),
            // 列名の前後空白は検証側 (trim 済み) と制約エディタ候補に合わせて落とす。
            columns: columns.map((c) => ({ ...c, name: c.name.trim() })),
            // id は React key 専用のローカル state なので純ロジックへ渡す前に落とす。
            foreignKeys: foreignKeys.filter(isCompleteForeignKey).map(({ id: _id, ...fk }) => fk),
            checks: checks.filter(isCompleteCheck).map(({ id: _id, ...ck }) => ck),
            options,
          })
        : [],
    [valid, driver, database, table, columns, foreignKeys, checks, options],
  );
  const sql = statements.join("\n");
  const columnNames = useMemo(
    () => [...new Set(columns.map((c) => c.name.trim()).filter((n) => n.length > 0))],
    [columns],
  );

  const dataListId = "create-table-types";

  return (
    <Modal
      onSubmit={() => onRun(sql, statements, table.trim())}
      submitDisabled={!valid || readOnly}
      width="820px"
      onClose={onClose}
    >
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
              <ListboxSelect
                id="create-table-template"
                value={templateTable}
                options={[
                  { value: "", label: t("createTableTemplateNone") },
                  ...tableNames.map((n) => ({ value: n })),
                ]}
                onChange={setTemplateTable}
                css={{ flex: "1", width: "100%" }}
              />
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
            gridTemplateColumns={COLUMN_GRID}
            gap="1.5"
            textStyle="overline"
            px="0.5"
            alignItems="end"
            // トグル列の見出しはトグルの真上に来るよう中央にそろえる。
            css={{ "& > span:nth-of-type(n+3):nth-of-type(-n+7)": { textAlign: "center" } }}
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
          <chakra.div mt="-1.5">
            <LiveRowsPresence>
              {columns.map((c, i) => (
                <LiveRow key={colKeys[i] ?? `col-fallback-${i}`}>
                  <chakra.div display="flex" flexDirection="column" gap="1">
                    <chakra.div
                      display="grid"
                      gridTemplateColumns={COLUMN_GRID}
                      gap="1.5"
                      alignItems="center"
                      justifyItems="stretch"
                      css={{ "& > :nth-child(n+3):nth-child(-n+7)": { justifySelf: "center" } }}
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
                        // 主キーは NULL を持てないので、オンにしたら NOT NULL も一緒にオンにする。
                        onChange={() =>
                          setCol(
                            i,
                            c.primaryKey ? { primaryKey: false } : { primaryKey: true, notNull: true },
                          )
                        }
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
                          onClick={() => removeCol(colKeys[i] ?? "")}
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
                          onBlur={() => touchGen(i)}
                          onChange={(e) =>
                            setCol(i, {
                              generated: {
                                ...(c.generated ?? { virtual: false }),
                                expression: e.target.value,
                              },
                            })
                          }
                          placeholder={t("createTableGeneratedExprPlaceholder")}
                          aria-label={`${t("createTableGeneratedExpr")} (${i + 1})`}
                          fontFamily="mono"
                          flex="1"
                        />
                        <ListboxSelect
                          value={c.generated.virtual ? "virtual" : "stored"}
                          options={[
                            { value: "stored", label: t("createTableGeneratedStored") },
                            // ListboxSelect には候補単位の disabled が無いので、非対応ドライバでは
                            // VIRTUAL を並べない (既に選択済みの場合だけ表示のため残す)。
                            ...(supportsVirtualGenerated(driver) || c.generated.virtual
                              ? [{ value: "virtual", label: t("createTableGeneratedVirtual") }]
                              : []),
                          ]}
                          onChange={(v) =>
                            setCol(i, {
                              generated: {
                                expression: c.generated?.expression ?? "",
                                virtual: v === "virtual",
                              },
                            })
                          }
                          ariaLabel={`${t("createTableGeneratedStorage")} (${i + 1})`}
                        />
                      </Flex>
                    )}
                  </chakra.div>
                </LiveRow>
              ))}
            </LiveRowsPresence>
          </chakra.div>
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

        <TableOptionsSection
          driver={driver}
          options={options}
          onChange={setOptions}
          problems={optionProblems}
        />

        <FormSection>
          <FieldLabel as="div">{t("createTablePreview")}</FieldLabel>
          <SqlPreview sql={sql} driver={driver} empty={t("createTablePreviewEmpty")} minH="60px" />
        </FormSection>
        {generatedErrors
          .filter((g) => g.problem !== "emptyExpression" || genTouched.includes(g.index))
          .map((g) => (
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
          onClick={() => onRun(sql, statements, table.trim())}
        >
          {t("createTableRun")}
        </PressableButton>
      </ModalFooter>
      {confirmDialog}
    </Modal>
  );
}

/** MySQL の ENGINE / CHARSET のサジェスト (自由入力も可)。 */
const MYSQL_ENGINES = ["InnoDB", "MyISAM", "MEMORY", "ARCHIVE", "CSV"];
const MYSQL_CHARSETS = ["utf8mb4", "utf8mb3", "latin1", "ascii", "binary"];

/** 入力の不備を画面の文言にする。 */
function optionProblemText(p: TableOptionProblem, t: ReturnType<typeof useT>): string {
  switch (p.code) {
    case "token":
      return t("createTableOptErrToken", { field: p.field.toUpperCase() });
    case "collationMismatch":
      return t("createTableOptErrCollation");
    case "strictType":
      return t("createTableOptErrStrictType", { columns: p.columns.join(", ") });
    case "withoutRowidNoPrimaryKey":
      return t("createTableOptErrWithoutRowidPk");
    case "withoutRowidAutoIncrement":
      return t("createTableOptErrWithoutRowidAuto");
    case "partitionKeyEmpty":
      return t("createTableOptErrKeyEmpty");
    case "partitionKeyUnknown":
      return t("createTableOptErrKeyUnknown", { columns: p.columns.join(", ") });
    case "partitionKeyUnique":
      return t("createTableOptErrKeyUnique", { columns: p.columns.join(", ") });
    case "partitionNeedsFirst":
      return t("createTableOptErrNeedsFirst");
    case "partitionCount":
      return t("createTableOptErrCount");
    case "partitionForeignKey":
      return t("createTableOptErrForeignKey");
    case "partitionBound":
      switch (p.error) {
        case "rangeEmpty":
          return t("createTableOptErrRange");
        case "listEmpty":
          return t("createTableOptErrList");
        case "hashModulus":
          return t("createTableOptErrModulus");
        case "hashRemainder":
          return t("createTableOptErrRemainder");
      }
  }
}

/**
 * 「テーブルオプション」節 (#2161)。折りたたみで、既定は閉じる。ドライバごとに出す項目が違う:
 * MySQL は ENGINE / CHARSET / COLLATE、PostgreSQL は UNLOGGED、SQLite は STRICT / WITHOUT ROWID。
 * MySQL と PostgreSQL はパーティション表 (方式・キー・最初のパーティション) も選べる。
 */
function TableOptionsSection({
  driver,
  options,
  onChange,
  problems,
}: {
  driver: DriverKind;
  options: TableOptions;
  onChange: (next: TableOptions) => void;
  problems: TableOptionProblem[];
}) {
  const t = useT();
  const set = (patch: Partial<TableOptions>) => onChange({ ...options, ...patch });
  const methods = partitionMethods(driver);
  const p = options.partition;
  const setPartition = (patch: Partial<PartitionSpec>) => {
    if (p) set({ partition: { ...p, ...patch } });
  };
  const methodLabel = (m: PartitionMethod) => m;
  const isMysql = driver === "mysql";
  const active = hasTableOptions(driver, options);
  return (
    <chakra.details>
      <chakra.summary
        cursor="pointer"
        textStyle="overline"
        color={problems.length > 0 ? "app.textError" : undefined}
      >
        {t("createTableOptions")}
        {active ? ` (${t("createTableOptionsActive")})` : ""}
        {problems.length > 0 ? ` [!${problems.length}]` : ""}
      </chakra.summary>
      <chakra.div display="flex" flexDirection="column" gap="3" marginTop="2">
        {isMysql && (
          <chakra.div display="grid" gridTemplateColumns="repeat(3, minmax(0, 1fr))" gap="3">
            <FormSection>
              <FieldLabel htmlFor="create-table-engine">ENGINE</FieldLabel>
              <Input
                id="create-table-engine"
                list="create-table-engines"
                value={options.engine}
                placeholder="InnoDB"
                onChange={(e) => set({ engine: e.target.value })}
              />
              <datalist id="create-table-engines">
                {MYSQL_ENGINES.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </FormSection>
            <FormSection>
              <FieldLabel htmlFor="create-table-charset">CHARSET</FieldLabel>
              <Input
                id="create-table-charset"
                list="create-table-charsets"
                value={options.charset}
                placeholder="utf8mb4"
                onChange={(e) => set({ charset: e.target.value })}
              />
              <datalist id="create-table-charsets">
                {MYSQL_CHARSETS.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </FormSection>
            <FormSection>
              <FieldLabel htmlFor="create-table-collation">COLLATE</FieldLabel>
              <Input
                id="create-table-collation"
                value={options.collation}
                placeholder="utf8mb4_0900_ai_ci"
                onChange={(e) => set({ collation: e.target.value })}
              />
            </FormSection>
          </chakra.div>
        )}

        {driver === "postgres" && (
          <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
            <Switch
              checked={options.unlogged && !p}
              disabled={!!p}
              onChange={() => set({ unlogged: !options.unlogged })}
              aria-label="UNLOGGED"
            />
            <span>UNLOGGED</span>
            <chakra.span textStyle="caption" color="app.textMuted">
              {p ? t("createTableOptUnloggedPartitioned") : t("createTableOptUnloggedHelp")}
            </chakra.span>
          </chakra.label>
        )}

        {driver === "sqlite" && (
          <>
            <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
              <Switch
                checked={options.strict}
                onChange={() => set({ strict: !options.strict })}
                aria-label="STRICT"
              />
              <span>STRICT</span>
              <chakra.span textStyle="caption" color="app.textMuted">
                {t("createTableOptStrictHelp")}
              </chakra.span>
            </chakra.label>
            <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
              <Switch
                checked={options.withoutRowid}
                onChange={() => set({ withoutRowid: !options.withoutRowid })}
                aria-label="WITHOUT ROWID"
              />
              <span>WITHOUT ROWID</span>
              <chakra.span textStyle="caption" color="app.textMuted">
                {t("createTableOptWithoutRowidHelp")}
              </chakra.span>
            </chakra.label>
          </>
        )}

        {methods.length > 0 && (
          <>
            <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
              <Switch
                checked={!!p}
                onChange={() => set({ partition: p ? null : emptyPartitionSpec(driver) })}
                aria-label={t("createTableOptPartition")}
              />
              <span>{t("createTableOptPartition")}</span>
            </chakra.label>
            {p && (
              <chakra.div display="flex" flexDirection="column" gap="3" paddingLeft="2">
                <chakra.div display="grid" gridTemplateColumns="minmax(0, 1fr) minmax(0, 2fr)" gap="3">
                  <FormSection>
                    <FieldLabel as="div">{t("createTableOptPartitionMethod")}</FieldLabel>
                    <ListboxSelect
                      ariaLabel={t("createTableOptPartitionMethod")}
                      value={p.method}
                      options={methods.map((m) => ({ value: m, label: methodLabel(m) }))}
                      onChange={(v) => setPartition({ method: v as PartitionMethod })}
                      css={{ width: "100%" }}
                    />
                  </FormSection>
                  <FormSection>
                    <FieldLabel htmlFor="create-table-part-key">{t("createTableOptPartitionKey")}</FieldLabel>
                    <Input
                      id="create-table-part-key"
                      fontFamily="mono"
                      value={p.key}
                      placeholder={t("createTableOptPartitionKeyPlaceholder")}
                      onChange={(e) => setPartition({ key: e.target.value })}
                    />
                  </FormSection>
                </chakra.div>
                <chakra.div textStyle="caption" color="app.textMuted">
                  {t("createTableOptPartitionKeyHelp")}
                </chakra.div>

                {(p.method === "HASH" || p.method === "KEY") && isMysql ? (
                  <FormSection>
                    <FieldLabel htmlFor="create-table-part-count">
                      {t("createTableOptPartitionCount")}
                    </FieldLabel>
                    <Input
                      id="create-table-part-count"
                      fontFamily="mono"
                      value={p.modulus}
                      onChange={(e) => setPartition({ modulus: e.target.value })}
                    />
                  </FormSection>
                ) : (
                  <>
                    <FormSection>
                      <FieldLabel htmlFor="create-table-part-first">
                        {isMysql
                          ? t("createTableOptPartitionFirstRequired")
                          : t("createTableOptPartitionFirst")}
                      </FieldLabel>
                      <Input
                        id="create-table-part-first"
                        fontFamily="mono"
                        value={p.firstName}
                        onChange={(e) => setPartition({ firstName: e.target.value })}
                      />
                    </FormSection>
                    {(isMysql || p.firstName.trim() !== "") && (
                      <chakra.div display="grid" gridTemplateColumns="repeat(2, minmax(0, 1fr))" gap="3">
                        {p.method === "RANGE" && !isMysql && (
                          <FormSection>
                            <FieldLabel htmlFor="create-table-part-from">
                              {t("createTableOptPartitionFrom")}
                            </FieldLabel>
                            <Input
                              id="create-table-part-from"
                              fontFamily="mono"
                              value={p.from}
                              onChange={(e) => setPartition({ from: e.target.value })}
                            />
                          </FormSection>
                        )}
                        {p.method === "RANGE" && (
                          <FormSection>
                            <FieldLabel htmlFor="create-table-part-to">
                              {isMysql
                                ? t("createTableOptPartitionLessThan")
                                : t("createTableOptPartitionTo")}
                            </FieldLabel>
                            <Input
                              id="create-table-part-to"
                              fontFamily="mono"
                              value={p.to}
                              onChange={(e) => setPartition({ to: e.target.value })}
                            />
                          </FormSection>
                        )}
                        {p.method === "LIST" && (
                          <FormSection>
                            <FieldLabel htmlFor="create-table-part-values">
                              {t("createTableOptPartitionValues")}
                            </FieldLabel>
                            <Input
                              id="create-table-part-values"
                              fontFamily="mono"
                              value={p.values}
                              placeholder="a, b, c"
                              onChange={(e) => setPartition({ values: e.target.value })}
                            />
                          </FormSection>
                        )}
                        {p.method === "HASH" && !isMysql && (
                          <>
                            <FormSection>
                              <FieldLabel htmlFor="create-table-part-modulus">MODULUS</FieldLabel>
                              <Input
                                id="create-table-part-modulus"
                                fontFamily="mono"
                                value={p.modulus}
                                onChange={(e) => setPartition({ modulus: e.target.value })}
                              />
                            </FormSection>
                            <FormSection>
                              <FieldLabel htmlFor="create-table-part-remainder">REMAINDER</FieldLabel>
                              <Input
                                id="create-table-part-remainder"
                                fontFamily="mono"
                                value={p.remainder}
                                onChange={(e) => setPartition({ remainder: e.target.value })}
                              />
                            </FormSection>
                          </>
                        )}
                      </chakra.div>
                    )}
                    <chakra.div textStyle="caption" color="app.textMuted">
                      {isMysql ? t("createTableOptBoundHelpMysql") : t("createTableOptBoundHelpPg")}
                    </chakra.div>
                  </>
                )}
              </chakra.div>
            )}
          </>
        )}

        {problems.map((pr, i) => (
          <FieldError key={`${pr.code}:${i}`}>{optionProblemText(pr, t)}</FieldError>
        ))}
      </chakra.div>
    </chakra.details>
  );
}
