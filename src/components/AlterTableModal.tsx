import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { useT } from "../i18n";
import {
  api,
  type CheckConstraintInfo,
  type DriverKind,
  type ForeignKey,
  type SqliteRebuildRiskKind,
} from "../api/tauri";
import {
  buildAlterPlan,
  constraintAlterNeedsRebuild,
  supportsColumnPosition,
  supportsComments,
  supportsConstraintAlter,
  type AlterStatement,
  type ExistingColumnBaseline,
  type ExistingColumnEdit,
  type IndexDef,
  duplicateColumnNames,
  renameCollisions,
  indexRowProblems,
  type NewColumn,
} from "./alterTable";
import { transitions, variants } from "../motion";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Checkbox, Input, PressableButton, Select, Switch } from "./ui";
import { Callout } from "./Callout";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";
import { TableConstraintEditor, type CheckRow, type FkRow } from "./TableConstraintEditor";
import { isCompleteCheck, isCompleteForeignKey } from "./tableConstraints";
import { buildAlterPrechecks, buildConstraintPrechecks } from "./alterPrecheck";
import { AlterPrecheckNotice } from "./AlterPrecheckNotice";
import { AlterCostNotice } from "./AlterCostNotice";
import { classifyAlterCost, hasMysqlCopyRisk, shouldWarnForRows, withMysqlOnlineClause } from "./alterCost";
import { useTableRowEstimate } from "../useTableRowEstimate";
import { useSqliteRebuildPlan } from "../useSqliteRebuildPlan";
import { DropColumnDependencies } from "./DropColumnDependencies";
import { useColumnDependencies } from "../useColumnDependencies";
import { COUNT_PREVIEW_TIMEOUT_SECS, useCountPreviews } from "../useCountPreviews";

/**
 * 既存テーブルの列編集ダイアログ (#794)。`describeTable` で現状の列を取得し、
 * 列の追加 / 変更 / 削除 / リネームとインデックス作成を 1 つのフォームで組み立てて
 * SQL をプレビューする。DDL 生成の純ロジックは `alterTable.ts` (方言別テスト付き)、
 * UI 構成は `CreateTableModal` と同じ流儀。read_only セッションでは実行ボタンを
 * 無効化する (バックエンドも write を拒否する)。実行そのものは呼び出し側 (App) が
 * `run_query_transaction` を通し、危険操作確認 (typedConfirmation) もそこで挟む —
 * `onRun` には (SQL 文字列ではなく) 生成済みの `AlterStatement[]` をそのまま渡し、
 * 破壊的判定 (`DROP COLUMN` を含むか) は各文の `destructive` フラグを見て行う
 * (SQL テキストの正規表現マッチには依存しない)。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string;
  table: string;
  readOnly: boolean;
  onRun: (statements: AlterStatement[]) => void;
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

/** `added`/`indexes` 行のローカル state に付ける安定 id。React key 用のみで
 *  `buildAlterPlan` へ渡す前に取り除く (フォーム行の並び替えは無いが、削除で
 *  配列インデックスがズレたときに入力途中の行の React state — IME 変換中の
 *  文字列や focus など — が別の行へ取り違えられないようにする)。 */
interface AddedColumnRow extends NewColumn {
  id: string;
}
interface IndexRow extends IndexDef {
  id: string;
  /** 利用者が一度触った (編集した / フォーカスを外した) 行。エラーはこの後に出す (#1532)。 */
  touched?: boolean;
}

/** 既存 FK 1 本 (制約名単位に畳んだもの)。`name` が無い制約は DROP できない。 */
interface ExistingFk {
  name: string | null;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

/** `foreign_keys` の 1 列 1 行を、対象テーブルの制約単位へ畳む。 */
function groupExistingFks(all: ForeignKey[], table: string): ExistingFk[] {
  const out: ExistingFk[] = [];
  const byName = new Map<string, ExistingFk>();
  for (const r of all) {
    if (r.table !== table) continue;
    const refCol = r.referenced_column ? [r.referenced_column] : [];
    const found = r.constraint_name ? byName.get(r.constraint_name) : undefined;
    if (found) {
      found.columns.push(r.column);
      found.refColumns.push(...refCol);
      continue;
    }
    const fk: ExistingFk = {
      name: r.constraint_name,
      columns: [r.column],
      refTable: r.referenced_table,
      refColumns: refCol,
    };
    if (r.constraint_name) byName.set(r.constraint_name, fk);
    out.push(fk);
  }
  return out;
}

function emptyNewColumn(driver: DriverKind): NewColumn {
  return { name: "", type: driver === "sqlite" ? "TEXT" : "VARCHAR(255)", notNull: false, defaultValue: "" };
}

/** `<select>` の値 ⇔ 位置指定。列名に `:` が含まれても `after:` の後ろを丸ごと列名として扱う。 */
function positionValue(p: NewColumn["position"]): string {
  if (!p || p.mode === "end") return "end";
  return p.mode === "first" ? "first" : `after:${p.column}`;
}

function parsePositionValue(v: string): NewColumn["position"] {
  if (v === "first") return { mode: "first" };
  if (v.startsWith("after:")) return { mode: "after", column: v.slice("after:".length) };
  return { mode: "end" };
}

/** 再作成のリスク種別 → i18n キー。 */
function rebuildRiskKey(kind: SqliteRebuildRiskKind) {
  switch (kind) {
    case "drop_column":
      return "alterTableRebuildRiskDropColumn";
    case "type_affinity":
      return "alterTableRebuildRiskTypeAffinity";
    case "not_null":
      return "alterTableRebuildRiskNotNull";
    case "add_not_null_column":
      return "alterTableRebuildRiskAddNotNullColumn";
    case "add_check":
      return "alterTableRebuildRiskAddCheck";
    case "add_foreign_key":
      return "alterTableRebuildRiskAddForeignKey";
  }
}

function emptyIndex(): IndexDef {
  return { name: "", columns: [], unique: false };
}

export function AlterTableModal({
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
  const [baseline, setBaseline] = useState<ExistingColumnBaseline[]>([]);
  const [existing, setExisting] = useState<ExistingColumnEdit[]>([]);
  const [added, setAdded] = useState<AddedColumnRow[]>([]);
  const [indexes, setIndexes] = useState<IndexRow[]>([]);
  // テーブルコメント (#1002)。`before` は DB の現状、`after` は入力値。
  const [tableComment, setTableComment] = useState({ before: "", after: "" });
  const commentsSupported = supportsComments(driver);
  // 外部キー / CHECK 制約 (#1191)。既存 FK は `foreign_keys` から読み、DROP 対象の
  // 制約名を `droppedFks` に持つ。CHECK は既存一覧を取得する経路が無いため、
  // 削除は制約名の入力で指定する。
  const constraintsSupported = supportsConstraintAlter(driver);
  const [existingFks, setExistingFks] = useState<ExistingFk[]>([]);
  const [droppedFks, setDroppedFks] = useState<string[]>([]);
  const [addedFks, setAddedFks] = useState<FkRow[]>([]);
  const [addedChecks, setAddedChecks] = useState<CheckRow[]>([]);
  const [droppedChecks, setDroppedChecks] = useState<{ id: string; name: string }[]>([]);
  // SQLite (#1888): 既存の CHECK 制約 (名前が無いものもあるので定義で指す) と、削除対象の定義。
  const [existingChecks, setExistingChecks] = useState<CheckConstraintInfo[]>([]);
  const [droppedCheckDefs, setDroppedCheckDefs] = useState<string[]>([]);
  const [tableNames, setTableNames] = useState<string[]>([]);
  // 付随情報 (コメント / FK / テーブル一覧) の取得に失敗して空で続行した種別 (#1614)。
  const [ctxWarnings, setCtxWarnings] = useState<string[]>([]);
  // `added`/`indexes` 行の React key を配列インデックスに頼らないための採番。
  const rowIdCounter = useRef(0);
  const nextRowId = () => `row${++rowIdCounter.current}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: driver の変化で再取得するためのトリガ依存 (effect 内では参照しない)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    // 現在の列・テーブルコメント・このテーブルの FK・テーブル名一覧を 1 回で取得する
    // (#1255)。コメント / FK / テーブル名は装飾的な付随情報なので、バックエンドは
    // その取得に失敗しても空で続行する (列の取得失敗だけがエラー)。続行した場合は
    // `warnings` で知らせ、帯で「表示が不完全」と出す (#1614)。
    api
      .alterTableContext(sessionId, database, table)
      .then((ctx) => {
        if (cancelled) return;
        const cols = ctx.columns;
        setExistingFks(groupExistingFks(ctx.foreign_keys, table));
        setDroppedFks([]);
        setExistingChecks(ctx.checks);
        setDroppedCheckDefs([]);
        setTableNames(ctx.table_names);
        setCtxWarnings(ctx.warnings);
        setTableComment({ before: ctx.table_comment, after: ctx.table_comment });
        const base: ExistingColumnBaseline[] = cols.map((c) => ({
          name: c.name,
          type: c.data_type,
          notNull: !c.nullable,
          defaultValue: c.default ?? "",
          extra: c.extra,
          comment: c.comment ?? "",
        }));
        setBaseline(base);
        setExisting(
          base.map((b) => ({
            original: b.name,
            drop: false,
            name: b.name,
            type: b.type,
            notNull: b.notNull,
            defaultValue: b.defaultValue,
            comment: b.comment ?? "",
          })),
        );
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
  }, [sessionId, driver, database, table]);

  const setExistingAt = (i: number, patch: Partial<ExistingColumnEdit>) =>
    setExisting((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const touchIndex = (i: number) =>
    setIndexes((rows) => rows.map((r, idx) => (idx === i && !r.touched ? { ...r, touched: true } : r)));
  // `existing[i].drop` を外側のクロージャから読まず、setState の関数更新内で
  // 反転させる (setExistingAt と同じ流儀に統一。連続クリックや古いレンダの
  // クロージャから stale な値を反転させてしまう余地をなくす)。
  const toggleDrop = (i: number) =>
    setExisting((rows) => rows.map((r, idx) => (idx === i ? { ...r, drop: !r.drop } : r)));

  const setAddedAt = (i: number, patch: Partial<NewColumn>) =>
    setAdded((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addNewColumn = () => setAdded((rows) => [...rows, { id: nextRowId(), ...emptyNewColumn(driver) }]);
  const removeNewColumn = (i: number) => setAdded((rows) => rows.filter((_, idx) => idx !== i));

  const setIndexAt = (i: number, patch: Partial<IndexDef>) =>
    setIndexes((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch, touched: true } : r)));
  const addIndex = () => setIndexes((rows) => [...rows, { id: nextRowId(), ...emptyIndex() }]);
  const removeIndex = (i: number) => setIndexes((rows) => rows.filter((_, idx) => idx !== i));
  const toggleIndexColumn = (i: number, col: string) =>
    setIndexes((rows) =>
      rows.map((r, idx) => {
        if (idx !== i) return r;
        const has = r.columns.includes(col);
        return {
          ...r,
          touched: true,
          columns: has ? r.columns.filter((c) => c !== col) : [...r.columns, col],
        };
      }),
    );

  // インデックスの列選択肢: 削除予定でない既存列 (リネーム後の名前) + 名前が
  // 入力済みの新規列。既存列をリネームせず新規列が同名を再利用するような
  // 縁のケースで重複しうるため `Set` で去重する。
  const availableColumns = useMemo(() => {
    const kept = existing.filter((e) => !e.drop).map((e) => e.name.trim() || e.original);
    const addedNames = added.map((c) => c.name.trim()).filter((n) => n.length > 0);
    return [...new Set([...kept, ...addedNames])];
  }, [existing, added]);

  // 新規列の位置指定 (#1625, MySQL のみ): AFTER の候補は、削除予定でない既存列と、
  // この行より前の新規列 (その ALTER が先に実行されるので参照できる)。
  const positionSupported = supportsColumnPosition(driver);
  const positionAnchors = (index: number) => {
    const kept = existing.filter((e) => !e.drop).map((e) => e.name.trim() || e.original);
    const earlier = added
      .slice(0, index)
      .map((c) => c.name.trim())
      .filter((n) => n.length > 0);
    return [...new Set([...kept, ...earlier])];
  };

  // DROP / 改名で選択肢から消えた列を選んだままの行は、その列を未選択として扱う。
  const effectiveIndexes = useMemo(
    () => indexes.map((r) => ({ ...r, columns: r.columns.filter((c) => availableColumns.includes(c)) })),
    [indexes, availableColumns],
  );

  const plan = useMemo(
    () =>
      buildAlterPlan(driver, {
        database,
        table,
        baseline,
        existing,
        // id は React key 専用のローカル state なので、純ロジックへ渡す前に取り除く。
        added: added.map((r) => ({
          name: r.name,
          type: r.type,
          notNull: r.notNull,
          defaultValue: r.defaultValue,
          position: r.position,
        })),
        indexes: effectiveIndexes.map((r) => ({ name: r.name, columns: r.columns, unique: r.unique })),
        tableComment,
        // id は React key 専用のローカル state なので純ロジックへ渡す前に落とす。
        addedForeignKeys: addedFks.filter(isCompleteForeignKey).map(({ id: _id, ...fk }) => fk),
        addedChecks: addedChecks.filter(isCompleteCheck).map(({ id: _id, ...ck }) => ck),
        droppedForeignKeys: droppedFks,
        droppedChecks: droppedChecks.map((c) => c.name),
        existingForeignKeys: existingFks.map((f) => ({
          name: f.name,
          columns: f.columns,
          refTable: f.refTable,
        })),
        droppedCheckDefinitions: droppedCheckDefs,
      }),
    [
      driver,
      database,
      table,
      baseline,
      existing,
      added,
      effectiveIndexes,
      tableComment,
      addedFks,
      addedChecks,
      droppedFks,
      droppedChecks,
      existingFks,
      droppedCheckDefs,
    ],
  );
  // 書き換え / 全件走査 / 長いロックを伴う操作 (#1771)。テーブルが小さければ警告しない。
  const costRisks = useMemo(
    () =>
      classifyAlterCost(driver, {
        baseline,
        existing,
        added,
        indexes: effectiveIndexes.filter((r) => indexRowProblems(r) === null),
        addedForeignKeys: addedFks.filter(isCompleteForeignKey),
        addedChecks: addedChecks.filter(isCompleteCheck),
      }),
    [driver, baseline, existing, added, effectiveIndexes, addedFks, addedChecks],
  );
  const rowEstimate = useTableRowEstimate(
    sessionId,
    database,
    table,
    !loading && !loadError && costRisks.length > 0,
  );
  const costRows = rowEstimate.status === "ok" ? rowEstimate.rows : null;
  const showCost = costRisks.length > 0 && (rowEstimate.status === "loading" || shouldWarnForRows(costRows));
  // MySQL: ALGORITHM=INPLACE, LOCK=NONE を付ける切り替え (#1771)。COPY が要る変更は実行時エラーで止まる。
  // 切り替えが見えない (該当する変更が無い) ときは付けない。
  const [onlineClause, setOnlineClause] = useState(false);
  const showOnlineToggle = showCost && driver === "mysql" && hasMysqlCopyRisk(costRisks);
  const applyOnline = onlineClause && showOnlineToggle;
  // SQLite の型 / NOT NULL / DEFAULT 変更・FK / CHECK の変更は、バックエンドがスキーマ同期と同じ
  // テーブル再作成 SQL を組み立てる (#1888)。生成中・失敗中は実行できない。
  const rebuildState = useSqliteRebuildPlan(sessionId, database, table, plan.rebuild, !loading && !loadError);
  const rebuildPending = plan.rebuild !== null && rebuildState.status !== "ok";
  const statements = useMemo(() => {
    const base = applyOnline ? withMysqlOnlineClause(driver, plan.statements) : plan.statements;
    if (plan.rebuild === null || rebuildState.status !== "ok") return base;
    const rebuildStatement: AlterStatement = {
      sql: rebuildState.plan.sql,
      kind: "rebuildTable",
      destructive: true,
    };
    return [rebuildStatement, ...base];
  }, [driver, applyOnline, plan.statements, plan.rebuild, rebuildState]);
  const hasRebuild = plan.rebuild !== null;
  // 名前が空 / 列未選択のインデックス行は文にならない。黙って捨てて実行できてしまうと
  // 「作ったつもり」になるので、行ごとにエラーを出して不備が残る間は実行を止める (#1532)。
  const hasIncompleteIndex = effectiveIndexes.some((r) => indexRowProblems(r) !== null);
  // 実行ボタン / Cmd+Enter を一度押された後は、空の行にもエラーを出す。
  const [runAttempted, setRunAttempted] = useState(false);
  // 適用後に同名の列が並ぶ (順序では解決できない本当の重複) と DB エラーになるので、実行前に止める。
  const duplicateNames = useMemo(
    () => duplicateColumnNames(driver, { baseline, existing, added }),
    [driver, baseline, existing, added],
  );
  // 入れ替え (a↔b)・連鎖 (a→b, b→c) のリネームは安全な実行順を作れないので止める。
  const collisionNames = useMemo(
    () => renameCollisions(driver, { baseline, existing }),
    [driver, baseline, existing],
  );
  const valid =
    statements.length > 0 && duplicateNames.length === 0 && collisionNames.length === 0 && !rebuildPending;
  // 不完全な行があるときは実行せず、理由を出す (空の新規行のエラーは触る/実行を試すまで伏せる)。
  const tryRun = () => {
    if (hasIncompleteIndex) {
      setRunAttempted(true);
      return;
    }
    onRun(statements);
  };

  const sqlPreview = statements.map((s: AlterStatement) => s.sql).join("\n");
  // 型の縮小・NOT NULL 追加で既存行が収まらないかの事前検査 (#1536)。読み取り専用の COUNT を
  // デバウンスして発行するので、read_only 接続でも動く。
  // FK / UNIQUE / CHECK の追加で既存データが違反しないかも同じ枠で検査する (#1757)。
  // 同じ ALTER で追加・リネームする列は現状のテーブルに無く COUNT が失敗するので、DB に既にある列だけを対象にする。
  const prechecks = useMemo(
    () => [
      ...buildAlterPrechecks(driver, database, table, baseline, existing),
      ...buildConstraintPrechecks(driver, database, table, {
        addedForeignKeys: addedFks.filter(isCompleteForeignKey),
        addedChecks: addedChecks.filter(isCompleteCheck),
        indexes: effectiveIndexes.filter((r) => indexRowProblems(r) === null),
        knownColumns: new Set(baseline.map((b) => b.name)),
        pendingColumns: new Set([
          ...added.map((c) => c.name.trim()).filter((n) => n),
          ...existing.filter((e) => !e.drop && e.name.trim() !== e.original).map((e) => e.name.trim()),
        ]),
      }),
    ],
    [driver, database, table, baseline, existing, added, addedFks, addedChecks, effectiveIndexes],
  );
  const runCount = useCallback(
    (sql: string) =>
      api.runLookupQuery({
        sessionId,
        sql,
        database,
        queryTimeoutSecs: COUNT_PREVIEW_TIMEOUT_SECS,
        rowCap: 1,
      }),
    [sessionId, database],
  );
  const precheckCounts = useCountPreviews(runCount, prechecks, !loading && !loadError);
  // DROP COLUMN の対象列を参照するビュー・生成列・インデックス・FK・トリガー (#1758)。
  const droppedColumns = useMemo(() => existing.filter((e) => e.drop).map((e) => e.original), [existing]);
  const columnDeps = useColumnDependencies(
    sessionId,
    database,
    table,
    droppedColumns,
    !loading && !loadError,
  );
  // 破壊的な文 (DROP COLUMN / DROP FOREIGN KEY / DROP CHECK) を含むか (#1529)。
  // 含むときは確認ダイアログと同じ破壊的パターン (実行は dangerOutline で左、
  // キャンセルを primary で右) に切り替え、Cmd/Ctrl+Enter での実行も止める。
  // 再作成の文は専用の注意枠 (リスク一覧つき) で見せるので、一覧の対象から外す。
  const destructiveStatements = statements.filter((s) => s.destructive && s.kind !== "rebuildTable");
  const hasDestructive = destructiveStatements.length > 0 || hasRebuild;

  return (
    <Modal
      onSubmit={hasDestructive ? undefined : tryRun}
      submitDisabled={!valid || readOnly}
      width="880px"
      onClose={onClose}
    >
      <ModalHeader onClose={onClose} closeLabel={t("createTableClose")}>
        {t("alterTableTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {/* 列一覧の読み込み (loading → ready/error) はテーブルを開くたび 1 回
            だけ起きる遷移で、以後は状態が戻らない。読み込み中のプレースホルダに
            フォーカス可能な要素は無いため、切替時にフォーカスを失う心配は
            ない (#1025)。 */}
        <AnimatePresence mode="wait" initial={false}>
          {loading && (
            <motion.div
              key="alter-table-loading"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("alterTableLoading")}
              </chakra.span>
            </motion.div>
          )}
          {!loading && loadError && (
            <motion.div
              key="alter-table-error"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <ErrorNote>{t("alterTableLoadError", { error: loadError })}</ErrorNote>
            </motion.div>
          )}
          {!loading && !loadError && (
            <motion.div
              key="alter-table-ready"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
            >
              {ctxWarnings.length > 0 && (
                <Callout tone="warning" data-testid="alter-context-warning">
                  {t("alterTableContextIncomplete", {
                    items: ctxWarnings
                      .map((w) =>
                        w === "comments"
                          ? t("alterTableCtxItemComments")
                          : w === "foreign_keys"
                            ? t("alterTableCtxItemForeignKeys")
                            : w === "checks"
                              ? t("alterTableCtxItemChecks")
                              : t("alterTableCtxItemTables"),
                      )
                      .join(" / "),
                  })}
                </Callout>
              )}
              <FormSection>
                <FieldLabel htmlFor="alter-table-comment">{t("alterTableTableComment")}</FieldLabel>
                <Input
                  id="alter-table-comment"
                  value={tableComment.after}
                  onChange={(e) => setTableComment((c) => ({ ...c, after: e.target.value }))}
                  placeholder={commentsSupported ? t("alterTableCommentPlaceholder") : undefined}
                  disabled={!commentsSupported}
                />
                {!commentsSupported && (
                  <chakra.span fontSize="xs" color="app.textMuted">
                    {t("alterTableCommentUnsupported")}
                  </chakra.span>
                )}
              </FormSection>

              <chakra.div display="flex" flexDirection="column" gap="1.5">
                <FieldLabel as="div">{t("alterTableExistingSection")}</FieldLabel>
                {driver === "mysql" && (
                  <chakra.span fontSize="xs" color="app.textMuted">
                    {t("alterTableMysqlExtraNote")}
                  </chakra.span>
                )}
                <chakra.div
                  display="grid"
                  gridTemplateColumns="1.1fr 1.1fr 1.3fr auto auto 1.2fr 1.2fr auto"
                  gap="1.5"
                  textStyle="overline"
                  px="0.5"
                >
                  <span>{t("createTableColName")}</span>
                  <span>{t("alterTableNewName")}</span>
                  <span>{t("createTableColType")}</span>
                  <span>{t("createTableColNotNull")}</span>
                  <span />
                  <span>{t("createTableColDefault")}</span>
                  <span>{t("alterTableColComment")}</span>
                  <span />
                </chakra.div>
                {existing.map((row, i) => (
                  <chakra.div
                    key={row.original}
                    display="grid"
                    gridTemplateColumns="1.1fr 1.1fr 1.3fr auto auto 1.2fr 1.2fr auto"
                    gap="1.5"
                    alignItems="center"
                    opacity={row.drop ? 0.5 : 1}
                  >
                    <Tooltip label={row.original}>
                      <chakra.span fontSize="sm" fontFamily="mono" color="app.text" minW="0" truncate>
                        {row.original}
                      </chakra.span>
                    </Tooltip>
                    <Input
                      value={row.name}
                      onChange={(e) => setExistingAt(i, { name: e.target.value })}
                      disabled={row.drop}
                      aria-label={`${t("alterTableNewName")}: ${row.original}`}
                    />
                    <Input
                      value={row.type}
                      onChange={(e) => setExistingAt(i, { type: e.target.value })}
                      disabled={row.drop}
                      aria-label={`${t("createTableColType")}: ${row.original}`}
                    />
                    <Switch
                      checked={row.notNull}
                      onChange={() => setExistingAt(i, { notNull: !row.notNull })}
                      disabled={row.drop}
                      aria-label={t("alterTableNotNullAria", { column: row.original })}
                    />
                    <span />
                    <Input
                      value={row.defaultValue}
                      onChange={(e) => setExistingAt(i, { defaultValue: e.target.value })}
                      placeholder={t("createTableColDefault")}
                      disabled={row.drop}
                      aria-label={`${t("createTableColDefault")}: ${row.original}`}
                    />
                    <Input
                      value={row.comment ?? ""}
                      onChange={(e) => setExistingAt(i, { comment: e.target.value })}
                      placeholder={commentsSupported ? t("alterTableColComment") : undefined}
                      disabled={row.drop || !commentsSupported}
                      aria-label={t("alterTableColCommentAria", { column: row.original })}
                    />
                    <Tooltip label={row.drop ? t("alterTableKeep") : t("alterTableDrop")}>
                      <chakra.button
                        type="button"
                        onClick={() => toggleDrop(i)}
                        aria-label={row.drop ? t("alterTableKeep") : t("alterTableDrop")}
                        color={row.drop ? "app.textError" : "app.textMuted"}
                        _hover={{ color: "app.textError" }}
                        px="1"
                      >
                        <Icon name={row.drop ? "undo" : "close"} />
                      </chakra.button>
                    </Tooltip>
                  </chakra.div>
                ))}
              </chakra.div>

              <chakra.div display="flex" flexDirection="column" gap="1.5">
                <FieldLabel as="div">{t("alterTableAddedSection")}</FieldLabel>
                {added.map((c, i) => (
                  <chakra.div
                    key={c.id}
                    display="grid"
                    gridTemplateColumns="1.3fr 1.3fr auto 1.2fr 1.2fr auto"
                    gap="1.5"
                    alignItems="center"
                  >
                    <Input
                      value={c.name}
                      onChange={(e) => setAddedAt(i, { name: e.target.value })}
                      placeholder={t("createTableColNamePlaceholder")}
                      aria-label={`${t("createTableColName")} (${i + 1})`}
                    />
                    <Input
                      value={c.type}
                      onChange={(e) => setAddedAt(i, { type: e.target.value })}
                      aria-label={`${t("createTableColType")} (${i + 1})`}
                    />
                    <Switch
                      checked={c.notNull}
                      onChange={() => setAddedAt(i, { notNull: !c.notNull })}
                      aria-label={t("alterTableNotNullNewAria", { n: i + 1 })}
                    />
                    <Input
                      value={c.defaultValue}
                      onChange={(e) => setAddedAt(i, { defaultValue: e.target.value })}
                      placeholder={t("createTableColDefault")}
                      aria-label={`${t("createTableColDefault")} (${i + 1})`}
                    />
                    <Tooltip
                      label={positionSupported ? undefined : t("alterTablePositionUnsupported")}
                      focusableWrapper={!positionSupported}
                    >
                      <Select
                        value={positionValue(c.position)}
                        onChange={(e) => setAddedAt(i, { position: parsePositionValue(e.target.value) })}
                        disabled={!positionSupported}
                        aria-label={t("alterTablePositionAria", { n: i + 1 })}
                      >
                        <option value="end">{t("alterTablePositionEnd")}</option>
                        <option value="first">{t("alterTablePositionFirst")}</option>
                        {positionAnchors(i).map((name) => (
                          <option key={name} value={`after:${name}`}>
                            {t("alterTablePositionAfter", { column: name })}
                          </option>
                        ))}
                      </Select>
                    </Tooltip>
                    <chakra.button
                      type="button"
                      onClick={() => removeNewColumn(i)}
                      aria-label={t("createTableRemoveCol")}
                      color="app.textMuted"
                      _hover={{ color: "app.textError" }}
                      px="1"
                    >
                      <Icon name="close" />
                    </chakra.button>
                  </chakra.div>
                ))}
                <Flex>
                  <Button type="button" variant="secondary" size="sm" onClick={addNewColumn}>
                    <Icon name="plus" /> {t("createTableAddCol")}
                  </Button>
                </Flex>
              </chakra.div>

              <chakra.div display="flex" flexDirection="column" gap="1.5">
                <FieldLabel as="div">{t("indexesLabel")}</FieldLabel>
                {indexes.map((idx, i) => {
                  const problems = idx.touched || runAttempted ? indexRowProblems(effectiveIndexes[i]) : null;
                  return (
                    <chakra.div
                      key={idx.id}
                      display="flex"
                      flexDirection="column"
                      gap="1.5"
                      p="2"
                      borderWidth="1px"
                      borderColor="app.border"
                      borderRadius="lg"
                    >
                      <Flex gap="1.5" align="center">
                        <Input
                          value={idx.name}
                          onChange={(e) => setIndexAt(i, { name: e.target.value })}
                          onBlur={() => touchIndex(i)}
                          placeholder={t("alterTableIndexNamePlaceholder")}
                          aria-label={t("alterTableIndexNamePlaceholder")}
                          flex="1"
                        />
                        <Switch
                          checked={idx.unique}
                          onChange={() => setIndexAt(i, { unique: !idx.unique })}
                          label={t("createTableColUnique")}
                        />
                        <chakra.button
                          type="button"
                          onClick={() => removeIndex(i)}
                          aria-label={t("alterTableRemoveIndex")}
                          color="app.textMuted"
                          _hover={{ color: "app.textError" }}
                          px="1"
                        >
                          <Icon name="close" />
                        </chakra.button>
                      </Flex>
                      {problems?.missingName && <FieldError>{t("alterTableIndexNameRequired")}</FieldError>}
                      <Flex gap="3" wrap="wrap">
                        {availableColumns.length === 0 && (
                          <chakra.span fontSize="xs" color="app.textMuted">
                            {t("treeNoColumns")}
                          </chakra.span>
                        )}
                        {availableColumns.map((col) => (
                          <chakra.label key={col} display="flex" alignItems="center" gap="1" fontSize="sm">
                            <Checkbox
                              checked={effectiveIndexes[i].columns.includes(col)}
                              onChange={() => toggleIndexColumn(i, col)}
                            />
                            {col}
                          </chakra.label>
                        ))}
                      </Flex>
                      {problems?.missingColumns && availableColumns.length > 0 && (
                        <FieldError>{t("alterTableIndexColumnsRequired")}</FieldError>
                      )}
                    </chakra.div>
                  );
                })}
                <Flex>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={addIndex}
                    disabled={availableColumns.length === 0}
                  >
                    <Icon name="plus" /> {t("alterTableAddIndex")}
                  </Button>
                </Flex>
              </chakra.div>

              <chakra.div display="flex" flexDirection="column" gap="1.5">
                <FieldLabel as="div">{t("alterTableConstraintsSection")}</FieldLabel>
                {existingFks.length > 0 && (
                  <chakra.div display="flex" flexDirection="column" gap="1">
                    <chakra.span fontSize="xs" color="app.textMuted">
                      {t("alterTableExistingFks")}
                    </chakra.span>
                    {existingFks.map((fk, i) => {
                      const dropped = fk.name !== null && droppedFks.includes(fk.name);
                      return (
                        <Flex
                          key={fk.name ?? `unnamed-${i}`}
                          gap="1.5"
                          align="center"
                          opacity={dropped ? 0.5 : 1}
                        >
                          <chakra.span fontSize="sm" fontFamily="mono" color="app.text" flex="1">
                            {fk.name && !constraintAlterNeedsRebuild(driver) ? `${fk.name}: ` : ""}
                            {t("alterTableFkTarget", {
                              columns: fk.columns.join(", "),
                              table: fk.refTable,
                              refColumns: fk.refColumns.join(", "),
                            })}
                          </chakra.span>
                          {fk.name === null ? (
                            <chakra.span fontSize="xs" color="app.textMuted">
                              {t("alterTableFkUnnamed")}
                            </chakra.span>
                          ) : (
                            <Switch
                              checked={dropped}
                              disabled={!constraintsSupported}
                              onChange={() => {
                                const name = fk.name;
                                if (name === null) return;
                                setDroppedFks((cur) =>
                                  cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name],
                                );
                              }}
                              aria-label={t("alterTableDropFk", { name: fk.name })}
                            />
                          )}
                        </Flex>
                      );
                    })}
                  </chakra.div>
                )}
                <TableConstraintEditor
                  idPrefix="alter-table"
                  foreignKeys={addedFks}
                  checks={addedChecks}
                  onForeignKeysChange={setAddedFks}
                  onChecksChange={setAddedChecks}
                  columnNames={availableColumns}
                  tableNames={tableNames}
                  nextId={nextRowId}
                  disabled={!constraintsSupported}
                />
                {constraintAlterNeedsRebuild(driver) && (
                  <chakra.span textStyle="caption">{t("alterTableConstraintSqliteNote")}</chakra.span>
                )}
                {constraintAlterNeedsRebuild(driver) && existingChecks.length > 0 && (
                  <chakra.div display="flex" flexDirection="column" gap="1">
                    <chakra.span textStyle="caption">{t("alterTableExistingChecks")}</chakra.span>
                    {existingChecks.map((ck) => {
                      const dropped = droppedCheckDefs.includes(ck.definition);
                      return (
                        <Flex
                          key={`${ck.name}:${ck.definition}`}
                          gap="1.5"
                          align="center"
                          opacity={dropped ? 0.5 : 1}
                        >
                          <chakra.span
                            fontSize="sm"
                            fontFamily="mono"
                            color="app.text"
                            flex="1"
                            wordBreak="break-all"
                          >
                            {ck.name ? `${ck.name}: ` : ""}
                            {ck.definition}
                          </chakra.span>
                          <Switch
                            checked={dropped}
                            onChange={() =>
                              setDroppedCheckDefs((cur) =>
                                cur.includes(ck.definition)
                                  ? cur.filter((d) => d !== ck.definition)
                                  : [...cur, ck.definition],
                              )
                            }
                            aria-label={t("alterTableDropCheck", { name: ck.name || ck.definition })}
                          />
                        </Flex>
                      );
                    })}
                  </chakra.div>
                )}
                {!constraintAlterNeedsRebuild(driver) && (
                  <chakra.div display="flex" flexDirection="column" gap="1.5">
                    <chakra.span fontSize="xs" color="app.textMuted">
                      {t("alterTableDropCheckSection")}
                    </chakra.span>
                    {droppedChecks.map((c, i) => (
                      <Flex key={c.id} gap="1.5" align="center">
                        <Input
                          value={c.name}
                          onChange={(e) =>
                            setDroppedChecks((rows) =>
                              rows.map((r, idx) => (idx === i ? { ...r, name: e.target.value } : r)),
                            )
                          }
                          placeholder={t("alterTableDropCheckPlaceholder")}
                          aria-label={t("alterTableDropCheckPlaceholder")}
                          flex="1"
                        />
                        <chakra.button
                          type="button"
                          onClick={() => setDroppedChecks((rows) => rows.filter((_, idx) => idx !== i))}
                          aria-label={t("alterTableDropCheckRemove")}
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
                        disabled={!constraintsSupported}
                        onClick={() => setDroppedChecks((rows) => [...rows, { id: nextRowId(), name: "" }])}
                      >
                        <Icon name="plus" /> {t("alterTableDropCheckAdd")}
                      </Button>
                    </Flex>
                  </chakra.div>
                )}
              </chakra.div>

              {hasRebuild && (
                <Callout
                  tone="warning"
                  role="status"
                  title={t("alterTableRebuildTitle")}
                  data-testid="alter-rebuild-notice"
                >
                  <chakra.div display="flex" flexDirection="column" gap="1">
                    <span>{t("alterTableRebuildBody")}</span>
                    {rebuildState.status === "loading" && <span>{t("alterTableRebuildPlanning")}</span>}
                    {rebuildState.status === "ok" &&
                      rebuildState.plan.risks.map((r) => (
                        <span key={`${r.kind}:${r.target}`}>
                          {t(rebuildRiskKey(r.kind), { target: r.target })}
                        </span>
                      ))}
                    {rebuildState.status === "ok" &&
                      rebuildState.plan.warnings.map((w) => (
                        <chakra.span key={w} fontSize="xs">
                          {w}
                        </chakra.span>
                      ))}
                  </chakra.div>
                </Callout>
              )}
              {rebuildState.status === "error" && (
                <ErrorNote>{t("alterTableRebuildPlanError", { error: rebuildState.error })}</ErrorNote>
              )}

              {destructiveStatements.length > 0 && (
                <Callout
                  tone="warning"
                  role="status"
                  title={t("alterTableDestructiveTitle", { count: destructiveStatements.length })}
                >
                  <chakra.div display="flex" flexDirection="column" gap="0.5">
                    <span>{t("alterTableDestructiveBody")}</span>
                    {destructiveStatements.map((s, i) => (
                      <chakra.code
                        key={`${i}-${s.sql}`}
                        fontFamily="mono"
                        fontSize="xs"
                        wordBreak="break-all"
                      >
                        {s.sql}
                      </chakra.code>
                    ))}
                  </chakra.div>
                </Callout>
              )}

              <FormSection>
                <FieldLabel as="div">{t("alterTablePreview")}</FieldLabel>
                <CodePreview minH="60px">{sqlPreview || t("alterTablePreviewEmpty")}</CodePreview>
              </FormSection>
              <AlterPrecheckNotice
                prechecks={prechecks}
                counts={precheckCounts}
                onOpenRows={onSendToEditor}
              />
              {showCost && (
                <AlterCostNotice
                  driver={driver}
                  risks={costRisks}
                  rows={costRows}
                  rowsLoading={rowEstimate.status === "loading"}
                  showOnlineToggle={showOnlineToggle}
                  onlineEnabled={onlineClause}
                  onOnlineChange={setOnlineClause}
                />
              )}
              <DropColumnDependencies state={columnDeps} />
              {hasIncompleteIndex && (
                <Callout tone="warning">{t("alterTableIndexIncompleteBlocked")}</Callout>
              )}
              {duplicateNames.length > 0 && (
                <FieldError>
                  {t("alterTableDuplicateColumn", { names: duplicateNames.join(", ") })}
                </FieldError>
              )}
              {collisionNames.length > 0 && (
                <FieldError>
                  {t("alterTableRenameCollision", { names: collisionNames.join(", ") })}
                </FieldError>
              )}
              {readOnly && <FieldError>{t("alterTableReadOnly")}</FieldError>}
            </motion.div>
          )}
        </AnimatePresence>
      </ModalBody>
      <ModalFooter>
        {hasDestructive ? (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={!valid || hasRebuild}
              onClick={() => onSendToEditor(sqlPreview)}
            >
              {t("createTableToEditor")}
            </Button>
            <Button type="button" variant="dangerOutline" disabled={!valid || readOnly} onClick={tryRun}>
              {t("alterTableRun")}
            </Button>
            <div style={{ flex: 1 }} />
            <Button type="button" variant="primary" onClick={onClose}>
              {t("createTableClose")}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={!valid || hasRebuild}
              onClick={() => onSendToEditor(sqlPreview)}
            >
              {t("createTableToEditor")}
            </Button>
            <div style={{ flex: 1 }} />
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("createTableClose")}
            </Button>
            <PressableButton type="button" variant="primary" disabled={!valid || readOnly} onClick={tryRun}>
              {t("alterTableRun")}
            </PressableButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
