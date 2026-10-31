import { connectRequestFromProfile } from "../connectRequest";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import {
  api,
  type ConnectionProfile,
  type DataDiff,
  type NormalizedColumn,
  type DiffStatus,
  type DriverKind,
  type SchemaDiff,
  type SyncKind,
  type SyncPlan,
  type SyncStatement,
  listenDataDiffProgress,
} from "../api/tauri";
import { countDmlStatements, type SyncRiskItem } from "../ai/syncRisk";
import { useT } from "../i18n";
import { rowKeyNote } from "../rowKey";
import { semanticColorVar } from "../semanticColors";
import { useSettings } from "../settings";
import { SurfaceRule } from "./SurfaceRule";
import { CrossDriverNotice, CrossDriverResult, crossDriverErrorKey } from "./CrossDriverVerify";
import { Callout } from "./Callout";
import { ErrorNote } from "./modalForm";
import { useConfirm } from "./ConfirmDialog";
import { AiSyncRisk, RiskBadge, type RiskByIndex } from "./AiSyncRisk";
import { Icon, ICON_SIZES } from "./Icon";
import { MigrationExportModal } from "./MigrationExportModal";
import { TextExportButton } from "./TextExportButton";
import {
  DEFAULT_DIFF_FILTERS,
  DIFF_ACTION_ORDER,
  type DiffFilters,
  filterTables,
  groupTables,
  resolveSelectedTable,
  statementsForTable,
} from "./schemaCompareModel";
import { schemaCompareReportMarkdown } from "./schemaCompareReport";
import { countObjectDifferences, objectKindLabel, SchemaObjectDiff } from "./SchemaObjectDiff";
import { Tooltip } from "./Tooltip";
import { Button, Checkbox, Heading, Input, PressableButton } from "./ui";
import { ListboxSelect } from "./ListboxSelect";
import { DraftNumberInput } from "./DraftNumberInput";
import { DiffFilterChip, statusLabel, TableDiffDetail, TableDiffList } from "./SchemaDiffDetail";
import { DataRowDiffTable } from "./DataRowDiffTable";

/**
 * スキーマ比較ビューの本体スタイル。各要素へ直接 `css` を適用する。
 * ステータス (DiffStatus) や
 * 種別 (SyncKind) で色が変わる箇所はヘルパ関数で分岐する。フォーム部品を内包する
 * ラッパ (`& select` / `& input`) だけはタグセレクタ (className ではなく要素スコープ)
 * で残す。
 */
const sidesCss: SystemStyleObject = {
  display: "flex",
  alignItems: "flex-end",
  gap: "3",
  margin: "var(--space-4) 0",
  flexWrap: "wrap",
};
const sideCss: SystemStyleObject = {
  display: "flex",
  flexDirection: "column",
  gap: "1.5",
  flex: "1 1 240px",
  minWidth: "200px",
  "& select": { width: "100%" },
};
const sideLabelCss: SystemStyleObject = {
  textStyle: "overline",
  color: "var(--text-secondary)",
};
const sideErrorCss: SystemStyleObject = {
  fontSize: "var(--text-xs)",
  color: semanticColorVar("danger", "text"),
};
const actionsCss: SystemStyleObject = { margin: "var(--space-3) 0" };
// 変数名は "warning" だが実際は接続/比較エラー文言に使われるため danger 役割へ
// マッピングする (#1009)。
const warningCss: SystemStyleObject = {
  color: semanticColorVar("danger", "text"),
  fontSize: "var(--text-sm)",
  margin: "var(--space-2) 0",
};
const emptyCss: SystemStyleObject = {
  color: "var(--text-muted)",
  fontSize: "var(--text-sm)",
  margin: "var(--space-4) 0",
};
const summaryCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "2",
  flexWrap: "wrap",
  margin: "var(--space-4) 0 var(--space-2-5)",
};
// 比較結果の 2 ペイン (左: テーブル一覧 / 右: 選んだテーブルの差分)。各ペインは
// 画面の高さに収めて個別にスクロールし、テーブルが多くても下の反映操作まで遠くしない。
const splitCss: SystemStyleObject = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 300px) minmax(0, 1fr)",
  gap: "2.5",
  alignItems: "stretch",
};
const paneCss: SystemStyleObject = {
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  background: "var(--bg-elevated)",
  overflowY: "auto",
  maxHeight: "65vh",
  minWidth: 0,
};
// 反映 SQL の操作バー。スクロールしても画面下端に留まり、どこからでも生成へ進める。
const syncBarCss: SystemStyleObject = {
  position: "sticky",
  bottom: 0,
  zIndex: "var(--z-sticky)",
  display: "flex",
  alignItems: "center",
  gap: "3",
  flexWrap: "wrap",
  marginTop: "4",
  padding: "var(--space-2-5) var(--space-3)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  background: "var(--bg-elevated)",
  boxShadow: "var(--shadow-md)",
};
const syncCss: SystemStyleObject = {
  marginTop: "6",
  paddingTop: "4",
  borderTop: "1px solid var(--border)",
};
const syncTitleCss: SystemStyleObject = { margin: "0 0 var(--space-1)", fontSize: "var(--text-md)" };
const syncControlsCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "3",
  flexWrap: "wrap",
  margin: "var(--space-2-5) 0",
};
// ソース表 → ターゲット表の 2 つのセレクト (#1880)。
const tablePairCss: SystemStyleObject = {
  display: "grid",
  gridTemplateColumns: "1fr auto 1fr",
  alignItems: "end",
  gap: "3",
  width: "100%",
};
const tableColCss: SystemStyleObject = { display: "flex", flexDirection: "column", gap: "1" };
// 非破壊の表示オプション (全行比較など) のラベル。危険色 (`destructiveCss`) にしない。
const optionLabelCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  fontSize: "var(--text-sm)",
  color: "var(--text)",
  cursor: "pointer",
};
const destructiveCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  fontSize: "var(--text-sm)",
  color: semanticColorVar("danger", "text"),
  cursor: "pointer",
};
const successCss: SystemStyleObject = {
  color: semanticColorVar("success", "text"),
  fontSize: "var(--text-sm)",
  margin: "var(--space-2) 0",
};
const statementsCss: SystemStyleObject = {
  listStyle: "none",
  margin: "var(--space-2) 0",
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "1.5",
};
const statementHeadCss: SystemStyleObject = {
  display: "flex",
  alignItems: "center",
  gap: "2",
  cursor: "pointer",
  marginBottom: "1.5",
};
const destructiveFlagCss: SystemStyleObject = {
  textStyle: "overline",
  color: semanticColorVar("danger", "text"),
};
const sqlCss: SystemStyleObject = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};
const backupCss: SystemStyleObject = {
  fontSize: "var(--text-sm)",
  color: semanticColorVar("warning", "text"),
  margin: "var(--space-2-5) 0",
};
const planWarningsCss: SystemStyleObject = {
  margin: "var(--space-2-5) 0 0",
  paddingLeft: "var(--space-4-5)",
  fontSize: "var(--text-sm)",
  color: "var(--text-muted)",
};
// 入力 (`<input>`) はタグセレクタ (要素スコープ) で幅を固定する。
const limitCss: SystemStyleObject = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1.5",
  fontSize: "var(--text-sm)",
  color: "var(--text-secondary)",
  "& input": { width: "80px" },
};
// 除外列の入力 (列名をカンマ区切りで並べるので件数上限より広く取る)。
const ignoreCss: SystemStyleObject = { ...limitCss, "& input": { width: "14em" } };

/** SyncKind に対応する文字色/枠色。`statusColors` と同じ tier 方針 (#1009)。 */
function kindColors(kind: SyncKind): { color: string; borderColor: string } {
  switch (kind) {
    case "create_table":
    case "add_column":
    case "add_foreign_key":
    case "add_check":
    case "add_index":
    case "create_object":
    case "insert_row": {
      const c = semanticColorVar("success", "text");
      return { color: c, borderColor: c };
    }
    case "alter_column":
    case "rebuild_table":
    case "replace_object":
    case "update_row": {
      const c = semanticColorVar("warning", "text");
      return { color: c, borderColor: c };
    }
    case "drop_column":
    case "drop_table":
    case "drop_index":
    case "drop_foreign_key":
    case "drop_check":
    case "drop_object":
    case "delete_row": {
      const c = semanticColorVar("danger", "text");
      return { color: c, borderColor: c };
    }
  }
}

/** 同期文の種別バッジ。 */
function kindCss(kind: SyncKind): SystemStyleObject {
  return {
    textStyle: "overline",
    padding: "var(--space-0-25) var(--space-2)",
    borderRadius: "var(--radius-pill)",
    border: "1px solid var(--border)",
    ...kindColors(kind),
  };
}

/** 同期文 1 件の枠。 */
function statementCss(destructive: boolean): SystemStyleObject {
  const base: SystemStyleObject = {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--bg-elevated)",
    py: "2",
    px: "2.5",
  };
  return destructive ? { ...base, borderColor: semanticColorVar("danger", "text") } : base;
}

type Side = "source" | "target";

/** `ConnectionProfile.driver` (プレーンな `string`) を `DriverKind` へ絞り込む。
 *  `MigrationExportModal` (#744) もヘッダのメタ情報生成で共有する。 */
export function coerceDriver(driver: string): DriverKind {
  return driver === "postgres" || driver === "sqlite" ? driver : "mysql";
}

/**
 * Default checklist selection for a generated plan: every non-destructive
 * statement is checked, destructive ones (DROP / DELETE) stay opt-in so an
 * "apply" can never silently destroy data even when they were generated.
 */
/** 同期プランを 1 度に描画する件数 (#1321)。 */
export const SYNC_STATEMENT_PAGE = 300;
/** テーブル差分一覧の 1 回あたりの描画件数 (#1612)。千テーブル規模でも初回描画を軽く保つ。 */
const TABLE_DIFF_PAGE = 300;

let dataDiffStreamSeq = 0;
/** 全行データ比較 1 回ごとの一意な stream id (進捗イベントと中止の宛先, #1612)。 */
function makeDataDiffStreamId(): string {
  dataDiffStreamSeq += 1;
  return `datadiff_${Date.now().toString(36)}_${dataDiffStreamSeq.toString(36)}`;
}

function defaultSelection(plan: SyncPlan): Set<number> {
  const next = new Set<number>();
  plan.statements.forEach((s, i) => {
    if (!s.destructive) next.add(i);
  });
  return next;
}

interface SideState {
  profileId: string | null;
  sessionId: string | null;
  databases: string[] | null;
  database: string | null;
  connecting: boolean;
  error: string | null;
}

const EMPTY_SIDE: SideState = {
  profileId: null,
  sessionId: null,
  databases: null,
  database: null,
  connecting: false,
  error: null,
};

/**
 * Schema comparison + sync: pick a source and a
 * target connection + database, view how their schemas differ, then optionally
 * generate the reconciling DDL and apply it to the target. Comparison runs over
 * short-lived read-only sessions this view opens on demand (one per distinct
 * profile) and tears down on close, so it never disturbs the main workspace
 * connection. Applying a sync plan opens a separate, writable session to the
 * target profile just for the transaction (rejected if that profile is
 * read-only) and disconnects it immediately after.
 */
export function SchemaCompareView({
  profiles,
  onClose,
  onOpenSql,
}: {
  profiles: ConnectionProfile[];
  onClose: () => void;
  /** 生成した SQL を新しいクエリタブで開く (実行はしない)。 */
  onOpenSql?: (sql: string, title: string) => void;
}) {
  const t = useT();
  const settings = useSettings();
  const { confirm, dialog: confirmDialog } = useConfirm();
  // 不可逆 (破壊的ステートメントを含む同期適用) × 本番接続の強確認ゲート
  // (対象接続名のタイプ入力。#675) に使う専用ダイアログ。破壊的 × 本番の
  // ケースだけこちらへ差し替え、それ以外は上の confirm (テーマ追従ダイアログ。#674) を使う。
  const { confirm: confirmTyped, dialog: typedConfirmDialog } = useConfirm();

  const [source, setSource] = useState<SideState>(EMPTY_SIDE);
  const [target, setTarget] = useState<SideState>(EMPTY_SIDE);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiff | null>(null);
  // 一覧の絞り込み (操作の種類 + テーブル名) と、右ペインに出すテーブル。
  const [filters, setFilters] = useState<DiffFilters>(DEFAULT_DIFF_FILTERS);
  const [tableQuery, setTableQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const toggleFilter = useCallback((status: DiffStatus) => {
    setFilters((prev) => ({ ...prev, [status]: !prev[status] }));
  }, []);

  // Sync state. A single plan / selection / apply path is shared
  // by the schema (DDL) and data (DML) generators; `planKind` records which one
  // produced the current plan so apply can refresh the right view afterwards.
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [planKind, setPlanKind] = useState<"schema" | "data" | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // 同期プランの描画件数 (#1321)。5,000 件超でも 1 画面ぶんだけ DOM に置き、続きは「さらに表示」。
  // 選択・適用は全件 (`plan.statements`) が対象。
  const [statementLimit, setStatementLimit] = useState(SYNC_STATEMENT_PAGE);
  // テーブル差分一覧の描画件数 (#1612)。差分・絞り込みが変わったら先頭ページへ戻す。
  const [tableLimit, setTableLimit] = useState(TABLE_DIFF_PAGE);
  const [generating, setGenerating] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  // 同期 SQL・エラー・適用結果をどちらの操作の近くに出すか (スキーマの反映 / データの同期)。
  const [syncArea, setSyncArea] = useState<"schema" | "data">("schema");
  // AI リスク要約 (#697) の結果。同期文の行にバッジを付けるだけで、適用フローには影響しない。
  const [risks, setRisks] = useState<RiskByIndex | null>(null);
  // プラン生成時に使ったフラグ。生成後にチェックを切り替えてもプランは作り直されないので、
  // AI には現在のチェック値ではなくこちらを渡す (#697)。
  const [planFlags, setPlanFlags] = useState({ allowDestructive: false, allowDelete: false });

  // Data sync state.
  const [dataTable, setDataTable] = useState<string>("");
  // ターゲット側の表名 (#1880)。空ならソースと同名。異名表・同一接続内の 2 表の照合に使う。
  const [dataTargetTable, setDataTargetTable] = useState<string>("");
  // 直近の比較で使った表の組 (比較後にセレクトを触っても表示は変わらない)。
  const [dataComparedTables, setDataComparedTables] = useState<{ source: string; target: string } | null>(
    null,
  );
  const [dataLimit, setDataLimit] = useState(1000);
  // 全行をキーセットページングで比較する (#1539)。既定オン。オフは従来の件数上限つき比較。
  const [dataAllRows, setDataAllRows] = useState(true);
  // 打ち切りメッセージは、比較した時点の設定 (全行 / 上限) で選ぶ。比較後に入力欄を触っても変わらない。
  const [dataComparedWith, setDataComparedWith] = useState<{ allRows: boolean; limit: number }>({
    allRows: true,
    limit: 1000,
  });
  // 比較から外す列 (カンマ区切り, #1539)。updated_at のように環境ごとに違う列を差分にしない。
  const [dataIgnore, setDataIgnore] = useState("");
  const [dataDiff, setDataDiff] = useState<DataDiff | null>(null);
  // ドライバをまたぐ検証専用の比較か・正規化して一致とみなした列 (#1869)。
  const [dataCross, setDataCross] = useState(false);
  const [dataNormalized, setDataNormalized] = useState<NormalizedColumn[]>([]);
  // ドライバが違う 2 つの接続では、スキーマ比較の結果が無いので表の一覧を直接取る (#1869)。
  const [crossTables, setCrossTables] = useState<{ source: string[]; target: string[] } | null>(null);
  const [crossTablesError, setCrossTablesError] = useState<string | null>(null);
  const wasCrossRef = useRef(false);
  // `dataDiff` をバックエンドが保持している ID (#1259)。SQL 生成にはこの ID だけを送る。
  const [dataDiffId, setDataDiffId] = useState<string | null>(null);
  const heldDiffIdRef = useRef<string | null>(null);
  const [dataComparing, setDataComparing] = useState(false);
  // 全行比較の進捗 (これまでに読んだ行数) と中止 (#1612)。
  const [dataProgressRows, setDataProgressRows] = useState<number | null>(null);
  const dataStreamIdRef = useRef<string | null>(null);
  // 比較開始時に全行比較だったか (比較中にチェックを外しても中止ボタンを残す)。
  const [dataCancellable, setDataCancellable] = useState(false);
  const dataCancelledRef = useRef(false);
  const [allowDelete, setAllowDelete] = useState(false);
  // 同期 SQL に含める行の種別 (#1625)。段階適用 (まず追加だけ、次に更新、最後に削除) 用。
  const [dataKinds, setDataKinds] = useState({
    source_only: true,
    different: true,
    target_only: true,
  });

  // 適用直後の再比較で得た差分。この差分への切り替えでは適用成功の表示を残す。
  const keepApplyResultForDiffRef = useRef<SchemaDiff | null>(null);

  // バックエンドが保持している差分を解放する。比較のやり直し・失敗・画面を閉じたときに呼ぶ。
  const releaseHeldDiff = useCallback(() => {
    const id = heldDiffIdRef.current;
    if (!id) return;
    heldDiffIdRef.current = null;
    void api.releaseDataDiffs([id]).catch(() => {});
  }, []);
  useEffect(() => releaseHeldDiff, [releaseHeldDiff]);

  // Any change to the schema diff invalidates a previously generated plan and
  // any in-flight data comparison (the connections / databases changed).
  useEffect(() => {
    setPlan(null);
    setPlanKind(null);
    setSelected(new Set());
    setSyncError(null);
    // 適用直後の再比較で得た差分では、適用成功の表示を消さない (#1599)。
    if (!diff || diff !== keepApplyResultForDiffRef.current) setApplyResult(null);
    setDataDiff(null);
    setDataDiffId(null);
    releaseHeldDiff();
    setDataTable("");
    setDataTargetTable("");
    setDataComparedTables(null);
  }, [diff, releaseHeldDiff]);

  // Sessions this view opened, keyed by profile id so the same profile chosen
  // on both sides reuses one connection. Disconnected on unmount.
  const ownedRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const owned = ownedRef.current;
    return () => {
      for (const sessionId of owned.values()) {
        api.disconnect(sessionId).catch(() => {});
      }
      owned.clear();
    };
  }, []);

  const ensureSession = useCallback(async (profile: ConnectionProfile): Promise<string> => {
    const existing = ownedRef.current.get(profile.id);
    if (existing) return existing;
    const res = await api.connect(
      // Comparison only introspects; force read-only and keep it out of history.
      connectRequestFromProfile(profile, { read_only: true, skip_history: true }),
    );
    ownedRef.current.set(profile.id, res.session_id);
    return res.session_id;
  }, []);

  // 各側の接続選択の最新要求番号 (古い応答の破棄用)。
  const selectSeqRef = useRef<Record<Side, number>>({ source: 0, target: 0 });

  const selectProfile = useCallback(
    async (side: Side, profileId: string) => {
      const setSide = side === "source" ? setSource : setTarget;
      // この要求が最新か (遅れて届いた古い接続結果で選択を巻き戻さない)。
      const seq = (selectSeqRef.current[side] += 1);
      const isCurrent = () => selectSeqRef.current[side] === seq;
      setDiff(null);
      setCompareError(null);
      if (!profileId) {
        setSide(EMPTY_SIDE);
        return;
      }
      setSide({ ...EMPTY_SIDE, profileId, connecting: true });
      const profile = profiles.find((p) => p.id === profileId);
      if (!profile) {
        setSide({ ...EMPTY_SIDE, profileId, error: "profile not found" });
        return;
      }
      try {
        const sessionId = await ensureSession(profile);
        const databases = await api.listDatabases(sessionId);
        const preferred =
          profile.database && databases.includes(profile.database)
            ? profile.database
            : (databases[0] ?? null);
        if (!isCurrent()) return;
        setSide({
          profileId,
          sessionId,
          databases,
          database: preferred,
          connecting: false,
          error: null,
        });
      } catch (e) {
        if (!isCurrent()) return;
        setSide({ ...EMPTY_SIDE, profileId, error: String(e) });
      }
    },
    [profiles, ensureSession],
  );

  const setDatabase = useCallback((side: Side, database: string) => {
    const setSide = side === "source" ? setSource : setTarget;
    setSide((prev) => ({ ...prev, database }));
    setDiff(null);
    setCompareError(null);
  }, []);

  const swap = useCallback(() => {
    setSource(target);
    setTarget(source);
    setDiff(null);
    setCompareError(null);
  }, [source, target]);

  const sourceDriver = useMemo(
    () => profiles.find((p) => p.id === source.profileId)?.driver ?? null,
    [profiles, source.profileId],
  );
  const targetDriver = useMemo(
    () => profiles.find((p) => p.id === target.profileId)?.driver ?? null,
    [profiles, target.profileId],
  );
  const driverMismatch = sourceDriver !== null && targetDriver !== null && sourceDriver !== targetDriver;

  // ドライバをまたぐ組み合わせでは、データ比較だけを許す (検証専用, #1869)。接続・DB が変わるたびに
  // 前回の結果を捨て、両側の表の一覧を取り直す。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 接続・DB の変化だけを契機にする。
  useEffect(() => {
    if (!driverMismatch && !wasCrossRef.current) return;
    wasCrossRef.current = driverMismatch;
    setCrossTables(null);
    setCrossTablesError(null);
    setDataTable("");
    setDataTargetTable("");
    setDataComparedTables(null);
    setDataDiff(null);
    setDataDiffId(null);
    setDataCross(false);
    setDataNormalized([]);
    setSyncError(null);
    releaseHeldDiff();
    if (!driverMismatch || !source.sessionId || !source.database || !target.sessionId || !target.database) {
      return;
    }
    let cancelled = false;
    Promise.all([
      api.listTables(source.sessionId, source.database),
      api.listTables(target.sessionId, target.database),
    ])
      .then(([s, tg]) => {
        if (!cancelled) setCrossTables({ source: s, target: tg });
      })
      .catch((e) => {
        if (!cancelled) setCrossTablesError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [driverMismatch, source.sessionId, source.database, target.sessionId, target.database]);

  const canCompare =
    !!source.sessionId &&
    !!source.database &&
    !!target.sessionId &&
    !!target.database &&
    !driverMismatch &&
    !comparing;

  const runCompare = useCallback(async (): Promise<SchemaDiff | null> => {
    if (!source.sessionId || !source.database || !target.sessionId || !target.database || driverMismatch) {
      return null;
    }
    setComparing(true);
    setCompareError(null);
    setDiff(null);
    try {
      const result = await api.compareSchema({
        sourceSessionId: source.sessionId,
        sourceDatabase: source.database,
        targetSessionId: target.sessionId,
        targetDatabase: target.database,
      });
      setDiff(result);
      return result;
    } catch (e) {
      setCompareError(String(e));
      return null;
    } finally {
      setComparing(false);
    }
  }, [source, target, driverMismatch]);

  const counts = useMemo(() => {
    const c = { source_only: 0, target_only: 0, different: 0, same: 0 };
    if (diff) for (const tbl of diff.tables) c[tbl.status] += 1;
    return c;
  }, [diff]);

  const visibleTables = useMemo(
    () => (diff ? filterTables(diff.tables, filters, tableQuery) : []),
    [diff, filters, tableQuery],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: 差分と絞り込みの変化を契機に先頭ページへ戻す。
  useEffect(() => {
    setTableLimit(TABLE_DIFF_PAGE);
  }, [diff, filters, tableQuery]);

  // 左ペインに描くぶん (#1612 のページング) と、そのうち選ばれているテーブル。
  const shownTables = useMemo(() => visibleTables.slice(0, tableLimit), [visibleTables, tableLimit]);
  const tableGroups = useMemo(() => groupTables(shownTables), [shownTables]);
  const selectedTable = useMemo(() => {
    const name = resolveSelectedTable(shownTables, selectedName);
    return shownTables.find((tbl) => tbl.name === name) ?? null;
  }, [shownTables, selectedName]);
  const selectedStatements = useMemo(
    () => (selectedTable ? statementsForTable(planKind === "schema" ? plan : null, selectedTable.name) : []),
    [selectedTable, planKind, plan],
  );

  /** 比較結果 (と生成済みのスキーマ同期 SQL) の Markdown レポート (#1624)。クリック時にだけ組む。 */
  const buildReport = (): string => {
    if (!diff) return "";
    const side = (s: SideState, profile: ConnectionProfile | null) =>
      `${profile?.name ?? s.profileId ?? ""} / ${s.database ?? ""}`;
    return schemaCompareReportMarkdown({
      source: side(source, sourceProfile),
      target: side(target, targetProfile),
      diff,
      plan: planKind === "schema" ? plan : null,
      hideSame: !filters.same,
      labels: {
        title: t("schemaCompareReportTitle"),
        source: t("schemaCompareSource"),
        target: t("schemaCompareTarget"),
        summaryHeading: t("schemaCompareReportSummary"),
        statusLabels: {
          source_only: statusLabel("source_only", t),
          target_only: statusLabel("target_only", t),
          different: statusLabel("different", t),
          same: statusLabel("same", t),
        },
        tablesHeading: t("schemaCompareReportTables"),
        tableCol: t("schemaCompareReportColTable"),
        statusCol: t("schemaCompareReportColStatus"),
        detailCol: t("schemaCompareReportColDetail"),
        identical: t("schemaCompareIdentical"),
        objectsHeading: t("schemaCompareObjectsTitle"),
        objectCol: t("schemaCompareReportColObject"),
        objectKind: (kind) => objectKindLabel(kind, t),
        objectsNotCompared: t("schemaCompareObjectsNotCompared"),
        objectsIdentical: t("schemaCompareObjectsIdentical"),
        planHeading: t("schemaCompareReportPlan"),
        planNote: t("schemaCompareReportPlanNote"),
        noStatements: t("schemaCompareNoStatements"),
        warningsHeading: t("schemaCompareReportWarnings"),
        destructive: t("schemaCompareReportDestructive"),
      },
    });
  };

  const objectDifferences = countObjectDifferences(diff?.objects);
  const hasDifferences = counts.different + counts.source_only + counts.target_only + objectDifferences > 0;

  // 生成した反映 SQL の一覧 (下の操作バーから飛ぶ先)。
  const planRef = useRef<HTMLDivElement | null>(null);
  const scrollToPlanPendingRef = useRef(false);
  const scrollToPlan = useCallback(() => {
    // jsdom など scrollIntoView を持たない環境では何もしない。
    planRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);
  // 「反映 SQL を生成」を押したら、生成された一覧まで送る (操作バーは画面下端に固定なので)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: プランの差し替えだけを契機にする。
  useEffect(() => {
    if (!scrollToPlanPendingRef.current || !plan) return;
    scrollToPlanPendingRef.current = false;
    scrollToPlan();
  }, [plan]);

  const generatePlan = useCallback(async () => {
    if (!diff) return;
    setSyncArea("schema");
    setGenerating(true);
    setSyncError(null);
    setApplyResult(null);
    try {
      const result = await api.generateSyncSql(diff, allowDestructive);
      setPlan(result);
      setRisks(null);
      setPlanFlags({ allowDestructive, allowDelete: false });
      setStatementLimit(SYNC_STATEMENT_PAGE);
      setPlanKind("schema");
      setSelected(defaultSelection(result));
      scrollToPlanPendingRef.current = true;
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setGenerating(false);
    }
  }, [diff, allowDestructive]);

  // Tables present on both sides — the only ones whose rows can be compared and
  // synced (a one-sided table would need its schema created/dropped first).
  const comparableTables = useMemo(
    () =>
      diff
        ? diff.tables
            .filter((tbl) => tbl.status === "same" || tbl.status === "different")
            .map((tbl) => tbl.name)
        : crossTables
          ? crossTables.source.filter((name) => crossTables.target.includes(name))
          : [],
    [diff, crossTables],
  );

  // ソース側に存在する表 / ターゲット側に存在する表 (#1880)。異名の表は片側にしか無い表も選べる。
  const sourceTableNames = useMemo(
    () =>
      diff
        ? diff.tables.filter((tbl) => tbl.status !== "target_only").map((tbl) => tbl.name)
        : (crossTables?.source ?? []),
    [diff, crossTables],
  );
  const targetTableNames = useMemo(
    () =>
      diff
        ? diff.tables.filter((tbl) => tbl.status !== "source_only").map((tbl) => tbl.name)
        : (crossTables?.target ?? []),
    [diff, crossTables],
  );
  // ターゲット未指定 (同名) のときは、同名の表が両側に無いと比較できない。
  // 比較できない組み合わせの理由 (ボタンを無効にして案内文を出す)。
  const effectiveTargetTable = dataTargetTable || dataTable;
  const dataTablesBlockReason: "same" | "noSameName" | null = (() => {
    if (!dataTable) return null;
    if (
      source.sessionId === target.sessionId &&
      source.database === target.database &&
      // MySQL / SQLite は表名の大小を区別しない環境があるので、バックエンドと同じく無視して比べる。
      (sourceDriver === "postgres"
        ? effectiveTargetTable === dataTable
        : effectiveTargetTable.toLowerCase() === dataTable.toLowerCase())
    ) {
      return "same";
    }
    if (dataTargetTable === "" && !comparableTables.includes(dataTable)) return "noSameName";
    return null;
  })();
  const dataTablesValid = dataTable !== "" && dataTablesBlockReason === null;

  const resetDataDiffForTableChange = () => {
    setDataDiff(null);
    setDataDiffId(null);
    releaseHeldDiff();
    if (planKind === "data") {
      setPlan(null);
      setPlanKind(null);
      setSelected(new Set());
      setApplyResult(null);
    }
  };

  const compareData = useCallback(async () => {
    if (!source.sessionId || !source.database || !target.sessionId || !target.database || !dataTablesValid) {
      return;
    }
    setDataComparing(true);
    setSyncArea("data");
    setSyncError(null);
    setApplyResult(null);
    setPlan(null);
    setPlanKind(null);
    setSelected(new Set());
    dataCancelledRef.current = false;
    setDataProgressRows(null);
    // 全行比較だけ、進捗の購読と中止のための stream id を渡す。
    const streamId = dataAllRows ? makeDataDiffStreamId() : null;
    dataStreamIdRef.current = streamId;
    setDataCancellable(streamId !== null);
    let unlisten: UnlistenFn | null = null;
    try {
      if (streamId) {
        unlisten = await listenDataDiffProgress(streamId, (e) => setDataProgressRows(e.rows));
      }
      const result = await api.compareTableData({
        sourceSessionId: source.sessionId,
        sourceDatabase: source.database,
        targetSessionId: target.sessionId,
        targetDatabase: target.database,
        table: dataTable,
        targetTable: dataTargetTable || null,
        limit: dataLimit,
        allRows: dataAllRows,
        ignoreColumns: dataIgnore
          .split(",")
          .map((c) => c.trim())
          .filter((c) => c !== ""),
        streamId,
      });
      // 直前の比較結果はバックエンドの保持を解放してから差し替える。
      releaseHeldDiff();
      heldDiffIdRef.current = result.diff_id;
      setDataComparedWith({ allRows: dataAllRows, limit: dataLimit });
      setDataComparedTables({ source: dataTable, target: dataTargetTable || dataTable });
      setDataDiff(result.diff);
      setDataDiffId(result.diff_id);
      setDataCross(result.cross_driver);
      setDataNormalized(result.normalized_columns);
    } catch (e) {
      // 利用者が中止したときはエラー表示にしない。
      setSyncError(dataCancelledRef.current ? t("schemaCompareDataCancelled") : String(e));
      releaseHeldDiff();
      setDataDiff(null);
      setDataDiffId(null);
      setDataCross(false);
      setDataNormalized([]);
    } finally {
      unlisten?.();
      dataStreamIdRef.current = null;
      setDataCancellable(false);
      setDataProgressRows(null);
      setDataComparing(false);
    }
  }, [
    t,
    source,
    target,
    dataTable,
    dataTargetTable,
    dataTablesValid,
    dataLimit,
    dataAllRows,
    dataIgnore,
    releaseHeldDiff,
  ]);

  // 画面を閉じたら、実行中の全行比較の問い合わせも止める。
  useEffect(
    () => () => {
      const streamId = dataStreamIdRef.current;
      if (streamId) void api.cancelStream(streamId).catch(() => {});
    },
    [],
  );

  const cancelDataCompare = useCallback(() => {
    const streamId = dataStreamIdRef.current;
    if (!streamId) return;
    dataCancelledRef.current = true;
    void api.cancelStream(streamId).catch(() => {});
  }, []);

  const generateDataPlan = useCallback(async () => {
    if (!dataDiffId) return;
    setSyncArea("data");
    setGenerating(true);
    setSyncError(null);
    setApplyResult(null);
    try {
      const picked = (["source_only", "different", "target_only"] as const).filter((k) => dataKinds[k]);
      const result = await api.generateDataSyncSql(
        dataDiffId,
        allowDelete,
        null,
        picked.length === 3 ? null : { kinds: picked },
      );
      setPlan(result);
      setRisks(null);
      setPlanFlags({ allowDestructive: false, allowDelete });
      setStatementLimit(SYNC_STATEMENT_PAGE);
      setPlanKind("data");
      setSelected(defaultSelection(result));
    } catch (e) {
      setSyncError(String(e));
    } finally {
      setGenerating(false);
    }
  }, [dataDiffId, allowDelete, dataKinds]);

  const dataCounts = useMemo(() => {
    const c = { source_only: 0, target_only: 0, different: 0 };
    if (dataDiff) for (const r of dataDiff.rows) c[r.status] += 1;
    return c;
  }, [dataDiff]);
  const dataKeyNote = dataDiff ? rowKeyNote(dataDiff.key_kind, dataDiff.primary_key) : null;

  const toggleStatement = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const sourceProfile = useMemo(
    () => profiles.find((p) => p.id === source.profileId) ?? null,
    [profiles, source.profileId],
  );
  const targetProfile = useMemo(
    () => profiles.find((p) => p.id === target.profileId) ?? null,
    [profiles, target.profileId],
  );

  // マイグレーションとして保存 (#744)。schema 系プラン (`generate_sync_sql` の
  // 出力) だけが対象 — down 側の生成が `compare_schema` の再実行を要するため、
  // データ同期プラン (`planKind === "data"`) はスコープ外。
  const [migrationExportOpen, setMigrationExportOpen] = useState(false);

  const applyPlan = useCallback(async () => {
    if (!plan || !targetProfile || !target.database) return;
    const statements = plan.statements.filter((_, i) => selected.has(i)).map((s) => s.sql);
    if (statements.length === 0) return;

    const destructiveCount = plan.statements.filter((s, i) => selected.has(i) && s.destructive).length;
    const confirmMsg = t("schemaCompareApplyConfirm", {
      count: statements.length,
      name: targetProfile.name,
      destructive: destructiveCount,
    });
    // データ同期は、適用する DML の件数を AI の要約とは独立に実数で出す (#1626)。
    const dml =
      planKind === "data" ? countDmlStatements(plan.statements.filter((_, i) => selected.has(i))) : null;
    const applyOk = await confirm({
      title: t("schemaCompareApply", { count: statements.length }),
      message: dml ? (
        <>
          {confirmMsg}
          <Box mt="2" fontWeight={600} data-testid="sync-dml-counts">
            {t("schemaCompareApplyDmlCounts", {
              deletes: dml.deletes.toLocaleString(),
              updates: dml.updates.toLocaleString(),
              inserts: dml.inserts.toLocaleString(),
            })}
          </Box>
        </>
      ) : (
        confirmMsg
      ),
      tone: destructiveCount > 0 ? "danger" : "warning",
    });
    if (!applyOk) return;
    if (targetProfile.is_production) {
      if (destructiveCount > 0) {
        // 不可逆 (破壊的ステートメントを含む適用) × 本番接続: 対象接続名の
        // タイプ入力を要求する強確認ゲート (#675)。`confirmProductionConnect`
        // 設定に関わらず常に要求する — 通常の本番接続警告より強い安全網。
        const ok = await confirmTyped({
          title: t("schemaCompareApplyTypedConfirmTitle"),
          message: t("schemaCompareApplyTypedConfirmBody", {
            name: targetProfile.name,
            destructive: destructiveCount,
          }),
          confirmLabel: t("schemaCompareApplyTypedConfirmOk"),
          tone: "danger",
          typedConfirmation: targetProfile.name,
        });
        if (!ok) return;
      } else if (settings.confirmProductionConnect) {
        const prodOk = await confirm({
          title: t("productionConfirmTitle"),
          message: t("schemaCompareApplyProductionConfirm", { name: targetProfile.name }),
          tone: "warning",
        });
        if (!prodOk) return;
      }
    }

    setApplying(true);
    setSyncError(null);
    setApplyResult(null);
    let writableSession: string | null = null;
    try {
      // Open a dedicated writable session to the target profile. read_only is
      // taken from the profile, so a read-only profile makes the backend reject
      // the apply (acceptance criterion).
      const res = await api.connect(connectRequestFromProfile(targetProfile, { skip_history: false }));
      writableSession = res.session_id;
      await api.applySyncSql({
        sessionId: res.session_id,
        database: target.database,
        statements,
      });
      const doneMessage = t("schemaCompareApplyDone", { count: statements.length });
      // Refresh whichever comparison produced this plan so the view reflects
      // the post-apply state. 再比較は適用結果の表示を消すので、終わってから設定する。
      if (planKind === "data") {
        await compareData();
      } else {
        const fresh = await runCompare();
        keepApplyResultForDiffRef.current = fresh;
      }
      setApplyResult(doneMessage);
    } catch (e) {
      setSyncError(String(e));
    } finally {
      if (writableSession) {
        api.disconnect(writableSession).catch(() => {});
      }
      setApplying(false);
    }
  }, [
    plan,
    planKind,
    selected,
    targetProfile,
    target.database,
    settings.confirmProductionConnect,
    confirmTyped,
    t,
    confirm,
    runCompare,
    compareData,
  ]);

  const selectedCount = selected.size;

  // 「接続名 / DB 名」。比較の向きの一文と詳細の表の見出しに使う。
  const sourceLabel = sourceProfile && source.database ? `${sourceProfile.name} / ${source.database}` : null;
  const targetLabel = targetProfile && target.database ? `${targetProfile.name} / ${target.database}` : null;

  const dataSection = sourceTableNames.length > 0 && targetTableNames.length > 0 && (
    <Box css={syncCss}>
      <chakra.h3 css={syncTitleCss}>
        {driverMismatch ? t("schemaCompareCrossHeading") : t("schemaCompareDataTitle")}
      </chakra.h3>
      {driverMismatch ? (
        <CrossDriverNotice />
      ) : (
        <chakra.p margin={0} fontSize="sm" color="app.textMuted">
          {t("schemaCompareDataDesc")}
        </chakra.p>
      )}
      <Box css={syncControlsCss}>
        <Box css={tablePairCss}>
          <Box css={tableColCss}>
            <chakra.span css={sideLabelCss}>{t("schemaCompareDataSourceTable")}</chakra.span>
            <ListboxSelect
              ariaLabel={t("schemaCompareDataSourceTable")}
              value={dataTable}
              disabled={dataComparing || generating}
              options={[
                { value: "", label: t("schemaCompareDataSelectTable") },
                ...sourceTableNames.map((name) => ({ value: name })),
              ]}
              onChange={(v) => {
                // 対象テーブルを変えたら前回のデータ差分・計画は別テーブルのものに
                // なるので破棄する (残すと前のテーブルの変更が流れる)。
                setDataTable(v);
                resetDataDiffForTableChange();
              }}
              css={{ width: "100%" }}
            />
          </Box>
          <chakra.span textStyle="caption" aria-hidden="true">
            →
          </chakra.span>
          <Box css={tableColCss}>
            <chakra.span css={sideLabelCss}>{t("schemaCompareDataTargetTable")}</chakra.span>
            <ListboxSelect
              ariaLabel={t("schemaCompareDataTargetTable")}
              value={dataTargetTable}
              disabled={dataComparing || generating}
              options={[
                { value: "", label: t("schemaCompareDataTargetSameName") },
                ...targetTableNames.map((name) => ({ value: name })),
              ]}
              onChange={(v) => {
                setDataTargetTable(v);
                resetDataDiffForTableChange();
              }}
              css={{ width: "100%" }}
            />
          </Box>
        </Box>
        <chakra.label css={optionLabelCss}>
          <Checkbox
            checked={dataAllRows}
            onChange={(e) => setDataAllRows(e.target.checked)}
            disabled={dataComparing}
          />
          {t("schemaCompareDataAllRows")}
        </chakra.label>
        {!dataAllRows && (
          <chakra.label css={limitCss}>
            {t("schemaCompareDataLimit")}
            <DraftNumberInput min={1} max={5000} value={dataLimit} onCommit={setDataLimit} />
          </chakra.label>
        )}
        <chakra.label css={ignoreCss}>
          {t("schemaCompareDataIgnore")}
          <Input
            value={dataIgnore}
            onChange={(e) => setDataIgnore(e.target.value)}
            placeholder={t("schemaCompareDataIgnorePlaceholder")}
            disabled={dataComparing}
          />
        </chakra.label>
        <Button onClick={compareData} disabled={!dataTablesValid || dataComparing}>
          {dataComparing ? t("schemaCompareComparing") : t("schemaCompareDataCompare")}
        </Button>
        {dataComparing && dataCancellable && (
          <>
            <chakra.span textStyle="caption">
              {t("schemaCompareDataProgress", { rows: (dataProgressRows ?? 0).toLocaleString() })}
            </chakra.span>
            <Button type="button" variant="secondary" size="sm" onClick={cancelDataCompare}>
              {t("schemaCompareDataCancel")}
            </Button>
          </>
        )}
      </Box>

      {dataTablesBlockReason && (
        <chakra.p margin={0} fontSize="sm" color="app.textWarning" role="status">
          {t(dataTablesBlockReason === "same" ? "schemaCompareDataSameTable" : "schemaCompareDataNoSameName")}
        </chakra.p>
      )}

      {driverMismatch && syncError && syncError === t("schemaCompareDataCancelled") && (
        <Callout tone="info" role="status">
          {syncError}
        </Callout>
      )}
      {driverMismatch && syncError && syncError !== t("schemaCompareDataCancelled") && (
        <ErrorNote title={t("schemaCompareCrossErrorTitle")}>
          {(() => {
            const key = crossDriverErrorKey(syncError);
            return key ? (
              <>
                {t(key)}
                <chakra.div textStyle="caption" wordBreak="break-all">
                  {t("schemaCompareCrossErrDetail", { detail: syncError })}
                </chakra.div>
              </>
            ) : (
              syncError
            );
          })()}
        </ErrorNote>
      )}
      {dataDiff && (
        <>
          <chakra.p margin={0} fontSize="sm" color="app.textMuted">
            {dataComparedTables && dataComparedTables.source !== dataComparedTables.target
              ? t("schemaCompareDataComparedPair", dataComparedTables)
              : t("schemaCompareDataComparedTable", { table: dataDiff.table })}
          </chakra.p>
          {dataCross ? (
            <>
              <CrossDriverResult diff={dataDiff} normalized={dataNormalized} />
              {dataDiff.truncated && (
                <chakra.p css={backupCss}>
                  {dataComparedWith.allRows
                    ? t("schemaCompareDataTruncatedAll")
                    : t("schemaCompareDataTruncated", { limit: dataComparedWith.limit })}
                </chakra.p>
              )}
            </>
          ) : (
            <>
              <DataRowDiffTable diff={dataDiff} />
              <Flex
                align="center"
                gap="3"
                flexWrap="wrap"
                role="group"
                aria-label={t("schemaCompareDataKinds")}
              >
                <chakra.span fontSize="sm" color="app.textSecondary">
                  {t("schemaCompareDataKinds")}
                </chakra.span>
                {(
                  [
                    ["source_only", "schemaCompareDataInserts"],
                    ["different", "schemaCompareDataUpdates"],
                    ["target_only", "schemaCompareDataDeletes"],
                  ] as const
                ).map(([kind, key]) => (
                  <chakra.label key={kind} css={optionLabelCss}>
                    <Checkbox
                      checked={dataKinds[kind]}
                      disabled={dataCounts[kind] === 0}
                      onChange={(e) => setDataKinds((prev) => ({ ...prev, [kind]: e.target.checked }))}
                    />
                    {t(key)}
                  </chakra.label>
                ))}
              </Flex>
              <chakra.p margin={0} textStyle="caption" color="app.textMuted">
                {t("schemaCompareDataKindsHint")}
              </chakra.p>
              {dataKeyNote && (
                <chakra.p margin={0} textStyle="caption" color="app.textMuted">
                  {t(dataKeyNote.key, dataKeyNote.vars)}
                </chakra.p>
              )}
              {dataDiff.truncated && (
                <chakra.p css={backupCss}>
                  {dataComparedWith.allRows
                    ? t("schemaCompareDataTruncatedAll")
                    : t("schemaCompareDataTruncated", { limit: dataComparedWith.limit })}
                </chakra.p>
              )}
              <Box css={syncControlsCss}>
                <chakra.label css={destructiveCss}>
                  <Checkbox checked={allowDelete} onChange={(e) => setAllowDelete(e.target.checked)} />
                  {t("schemaCompareAllowDelete")}
                </chakra.label>
                <Button onClick={generateDataPlan} disabled={generating}>
                  {generating ? t("schemaCompareGenerating") : t("schemaCompareDataGenerate")}
                </Button>
              </Box>
            </>
          )}
        </>
      )}
    </Box>
  );

  // 同期 SQL の一覧と結果。スキーマの反映は操作バーの直下、データの同期はデータ比較の下に出す。
  const planBlock = (
    <>
      {syncError && <chakra.p css={warningCss}>{syncError}</chakra.p>}
      {applyResult && <chakra.p css={successCss}>{applyResult}</chakra.p>}

      {plan && (
        <Box ref={planRef}>
          {plan.statements.length === 0 ? (
            <chakra.p css={emptyCss}>{t("schemaCompareNoStatements")}</chakra.p>
          ) : (
            <>
              <chakra.ul css={statementsCss}>
                {plan.statements.slice(0, statementLimit).map((stmt, i) => (
                  <SyncStatementRow
                    key={`${stmt.table}-${i}`}
                    index={i}
                    statement={stmt}
                    checked={selected.has(i)}
                    onToggle={toggleStatement}
                    risks={risks?.get(i)}
                  />
                ))}
              </chakra.ul>
              {plan.statements.length > statementLimit && (
                <Box css={actionsCss} display="flex" gap="2" alignItems="center">
                  <chakra.span fontSize="xs" color="app.textMuted" textStyle="numeric">
                    {t("schemaCompareStatementsShown", {
                      shown: statementLimit,
                      total: plan.statements.length,
                    })}
                  </chakra.span>
                  <Button type="button" onClick={() => setStatementLimit((n) => n + SYNC_STATEMENT_PAGE)}>
                    {t("schemaCompareStatementsMore", {
                      count: Math.min(SYNC_STATEMENT_PAGE, plan.statements.length - statementLimit),
                    })}
                  </Button>
                </Box>
              )}
              {planKind && sourceDriver && targetDriver && (
                <AiSyncRisk
                  plan={plan}
                  planKind={planKind}
                  diff={diff}
                  dataSummary={
                    planKind === "data" && dataDiff
                      ? { table: dataDiff.table, truncated: dataDiff.truncated }
                      : null
                  }
                  sourceDriver={coerceDriver(sourceDriver)}
                  targetDriver={coerceDriver(targetDriver)}
                  allowDestructive={planFlags.allowDestructive}
                  allowDelete={planFlags.allowDelete}
                  kindLabel={(k) => syncKindLabel(k, t)}
                  isProduction={!!sourceProfile?.is_production || !!targetProfile?.is_production}
                  onRisks={setRisks}
                />
              )}
              <chakra.p css={backupCss}>{t("schemaCompareBackupNote")}</chakra.p>
              <Box css={actionsCss} display="flex" gap="2" flexWrap="wrap">
                <PressableButton
                  variant="primary"
                  onClick={applyPlan}
                  disabled={applying || selectedCount === 0}
                >
                  {applying ? t("schemaCompareApplying") : t("schemaCompareApply", { count: selectedCount })}
                </PressableButton>
                {planKind === "schema" && (
                  <Button type="button" onClick={() => setMigrationExportOpen(true)}>
                    {t("schemaCompareSaveMigration")}
                  </Button>
                )}
              </Box>
            </>
          )}
          {plan.warnings.length > 0 && (
            <chakra.ul css={planWarningsCss}>
              {plan.warnings.map((w, i) => (
                <chakra.li key={i}>{w}</chakra.li>
              ))}
            </chakra.ul>
          )}
        </Box>
      )}
    </>
  );
  return (
    <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="4.5">
      <chakra.header
        position="relative"
        display="flex"
        alignItems="center"
        justifyContent="space-between"
        gap="3"
        borderBottom="1px solid"
        borderColor="app.border"
        paddingBottom="2.5"
      >
        <Heading>{t("schemaCompareTitle")}</Heading>
        <Tooltip label={t("schemaCompareClose")}>
          <Button
            minWidth="28px"
            px="2"
            py="1"
            fontSize="base"
            lineHeight={1}
            onClick={onClose}
            aria-label={t("schemaCompareClose")}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </Button>
        </Tooltip>
        <SurfaceRule />
      </chakra.header>

      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("schemaCompareDesc")}
      </chakra.p>

      {profiles.length === 0 ? (
        <chakra.p css={emptyCss}>{t("schemaCompareNoProfiles")}</chakra.p>
      ) : (
        <>
          <Box css={sidesCss}>
            <SidePicker
              label={t("schemaCompareSource")}
              hint={t("schemaCompareSourceHint")}
              changes={false}
              side="source"
              state={source}
              profiles={profiles}
              onSelectProfile={selectProfile}
              onSelectDatabase={setDatabase}
              t={t}
            />
            <Flex direction="column" align="center" justify="center" gap="2" alignSelf="center" flex="none">
              <chakra.span color="app.accent" display="inline-flex" aria-hidden>
                <Icon name="chevron-right" size={ICON_SIZES.xl} />
              </chakra.span>
              <Tooltip label={t("schemaCompareSwap")}>
                <Button
                  type="button"
                  minWidth="28px"
                  px="2"
                  py="1"
                  fontSize="base"
                  lineHeight={1}
                  onClick={swap}
                  aria-label={t("schemaCompareSwap")}
                >
                  <Icon name="transfer" size={ICON_SIZES.md} />
                </Button>
              </Tooltip>
            </Flex>
            <SidePicker
              label={t("schemaCompareTarget")}
              hint={t("schemaCompareTargetHint")}
              changes
              side="target"
              state={target}
              profiles={profiles}
              onSelectProfile={selectProfile}
              onSelectDatabase={setDatabase}
              t={t}
            />
          </Box>

          {driverMismatch && <chakra.p css={warningCss}>{t("schemaCompareDriverMismatch")}</chakra.p>}
          {driverMismatch && crossTablesError && (
            <chakra.p css={warningCss}>
              {t("schemaCompareCrossNoTables", { error: crossTablesError })}
            </chakra.p>
          )}
          {driverMismatch && !diff && dataSection}

          <Flex css={actionsCss} align="center" gap="3" flexWrap="wrap">
            <PressableButton variant="primary" onClick={runCompare} disabled={!canCompare}>
              {comparing ? t("schemaCompareComparing") : t("schemaCompareCompare")}
            </PressableButton>
            {sourceLabel && targetLabel && !driverMismatch && (
              <chakra.p m={0} textStyle="body" color="app.textSecondary">
                {t("schemaCompareDirection", { source: sourceLabel, target: targetLabel })}
              </chakra.p>
            )}
          </Flex>

          {compareError && <chakra.p css={warningCss}>{compareError}</chakra.p>}

          {diff && (
            <Box>
              <Box css={summaryCss} role="group" aria-label={t("schemaCompareFilterLabel")}>
                {DIFF_ACTION_ORDER.map((status) => (
                  <DiffFilterChip
                    key={status}
                    status={status}
                    count={counts[status]}
                    active={filters[status]}
                    onToggle={toggleFilter}
                    t={t}
                  />
                ))}
                <Input
                  type="search"
                  flex="0 1 220px"
                  minW="120px"
                  value={tableQuery}
                  placeholder={t("schemaCompareSearchTables")}
                  aria-label={t("schemaCompareSearchTables")}
                  onChange={(e) => setTableQuery(e.target.value)}
                />
                <Box marginLeft="auto">
                  <TextExportButton
                    formats={[{ id: "markdown", label: "Markdown", build: buildReport }]}
                    filenameBase="schema-compare"
                    label={t("schemaCompareReport")}
                  />
                </Box>
              </Box>

              {visibleTables.length === 0 ? (
                <chakra.p css={emptyCss}>
                  {counts.different + counts.source_only + counts.target_only === 0
                    ? t(objectDifferences > 0 ? "schemaCompareTablesIdentical" : "schemaCompareIdentical")
                    : t("schemaCompareNoMatch")}
                </chakra.p>
              ) : (
                <Box css={splitCss}>
                  <Box css={paneCss}>
                    <TableDiffList
                      groups={tableGroups}
                      selected={selectedTable?.name ?? null}
                      onSelect={setSelectedName}
                      t={t}
                    />
                    {visibleTables.length > tableLimit && (
                      <Flex direction="column" gap="1.5" p="2.5" align="flex-start">
                        <chakra.span textStyle="caption">
                          {t("schemaCompareTablesShown", {
                            shown: tableLimit,
                            total: visibleTables.length,
                          })}
                        </chakra.span>
                        <Button type="button" onClick={() => setTableLimit((n) => n + TABLE_DIFF_PAGE)}>
                          {t("schemaCompareStatementsMore", {
                            count: Math.min(TABLE_DIFF_PAGE, visibleTables.length - tableLimit),
                          })}
                        </Button>
                      </Flex>
                    )}
                  </Box>
                  <Box css={paneCss} p="3.5">
                    {selectedTable ? (
                      <TableDiffDetail
                        table={selectedTable}
                        sourceName={sourceLabel ?? ""}
                        targetName={targetLabel ?? ""}
                        statements={selectedStatements}
                        planReady={planKind === "schema" && plan !== null}
                        t={t}
                      />
                    ) : (
                      <chakra.p css={emptyCss}>{t("schemaCompareSelectTablePrompt")}</chakra.p>
                    )}
                  </Box>
                </Box>
              )}

              {diff.objects && (
                <SchemaObjectDiff
                  objects={diff.objects}
                  driver={diff.target_driver}
                  hideSame={!filters.same}
                />
              )}

              {hasDifferences && (
                <Box css={syncBarCss}>
                  <Flex align="center" gap="1.5" minW={0}>
                    <chakra.span textStyle="body" fontWeight={600}>
                      {t("schemaCompareSyncTitle")}
                    </chakra.span>
                    <Tooltip label={t("schemaCompareSyncDesc")}>
                      <chakra.span
                        display="inline-flex"
                        color="app.textMuted"
                        tabIndex={0}
                        aria-label={t("schemaCompareSyncDesc")}
                      >
                        <Icon name="info" size={ICON_SIZES.sm} />
                      </chakra.span>
                    </Tooltip>
                  </Flex>
                  <Tooltip label={t("schemaCompareAllowDestructiveObjects")}>
                    <chakra.label css={destructiveCss}>
                      <Checkbox
                        checked={allowDestructive}
                        onChange={(e) => setAllowDestructive(e.target.checked)}
                      />
                      {t("schemaCompareAllowDestructiveShort")}
                    </chakra.label>
                  </Tooltip>
                  <Box flex="1" />
                  {planKind === "schema" && plan && plan.statements.length > 0 && (
                    <Button type="button" onClick={scrollToPlan}>
                      {t("schemaCompareShowPlan", { count: plan.statements.length })}
                    </Button>
                  )}
                  <PressableButton variant="primary" onClick={generatePlan} disabled={generating}>
                    {generating ? t("schemaCompareGenerating") : t("schemaCompareGenerate")}
                  </PressableButton>
                </Box>
              )}

              {syncArea === "schema" && planBlock}

              {dataSection}

              {syncArea === "data" && planBlock}
            </Box>
          )}
        </>
      )}
      {confirmDialog}
      {typedConfirmDialog}
      {migrationExportOpen &&
        plan &&
        planKind === "schema" &&
        sourceProfile &&
        targetProfile &&
        source.sessionId &&
        source.database &&
        target.sessionId &&
        target.database && (
          <MigrationExportModal
            plan={plan}
            allowDestructive={allowDestructive}
            sourceSessionId={source.sessionId}
            sourceDatabase={source.database}
            sourceProfile={sourceProfile}
            targetSessionId={target.sessionId}
            targetDatabase={target.database}
            targetProfile={targetProfile}
            onOpenInEditor={onOpenSql}
            onClose={() => setMigrationExportOpen(false)}
          />
        )}
    </Box>
  );
}

function syncKindLabel(kind: SyncKind, t: ReturnType<typeof useT>): string {
  switch (kind) {
    case "create_table":
      return t("schemaCompareKindCreateTable");
    case "add_column":
      return t("schemaCompareKindAddColumn");
    case "alter_column":
      return t("schemaCompareKindAlterColumn");
    case "add_foreign_key":
      return t("schemaCompareKindAddForeignKey");
    case "drop_column":
      return t("schemaCompareKindDropColumn");
    case "drop_table":
      return t("schemaCompareKindDropTable");
    case "add_index":
      return t("schemaCompareKindAddIndex");
    case "drop_index":
      return t("schemaCompareKindDropIndex");
    case "drop_foreign_key":
      return t("schemaCompareKindDropForeignKey");
    case "add_check":
      return t("schemaCompareKindAddCheck");
    case "drop_check":
      return t("schemaCompareKindDropCheck");
    case "create_object":
      return t("schemaCompareKindCreateObject");
    case "replace_object":
      return t("schemaCompareKindReplaceObject");
    case "drop_object":
      return t("schemaCompareKindDropObject");
    case "rebuild_table":
      return t("schemaCompareKindRebuildTable");
    case "insert_row":
      return t("schemaCompareKindInsertRow");
    case "update_row":
      return t("schemaCompareKindUpdateRow");
    case "delete_row":
      return t("schemaCompareKindDeleteRow");
  }
}

/** 同期文の外枠 CSS (#1321: 行ごとにオブジェクトを作り直さないよう 2 種類を使い回す)。 */
const STATEMENT_CSS = { normal: statementCss(false), destructive: statementCss(true) };
const KIND_CSS_CACHE = new Map<SyncKind, SystemStyleObject>();
function cachedKindCss(kind: SyncKind): SystemStyleObject {
  let c = KIND_CSS_CACHE.get(kind);
  if (!c) {
    c = kindCss(kind);
    KIND_CSS_CACHE.set(kind, c);
  }
  return c;
}

/**
 * 同期文 1 行 (#1321)。`memo` + index を引数に取る安定した `onToggle` により、
 * チェックボックス 1 つの切替で再レンダーされるのは当該行だけ。
 */
export const SyncStatementRow = memo(function SyncStatementRow({
  index,
  statement,
  checked,
  onToggle,
  risks,
}: {
  index: number;
  statement: SyncStatement;
  checked: boolean;
  onToggle: (index: number) => void;
  /** AI リスク要約 (#697) の該当項目。未実行なら undefined。 */
  risks?: readonly SyncRiskItem[];
}) {
  const t = useT();
  return (
    <chakra.li css={statement.destructive ? STATEMENT_CSS.destructive : STATEMENT_CSS.normal}>
      <chakra.label css={statementHeadCss}>
        <Checkbox checked={checked} onChange={() => onToggle(index)} />
        <chakra.span css={cachedKindCss(statement.kind)}>{syncKindLabel(statement.kind, t)}</chakra.span>
        {statement.destructive && (
          <chakra.span css={destructiveFlagCss}>{t("schemaCompareDestructiveFlag")}</chakra.span>
        )}
      </chakra.label>
      <chakra.code css={sqlCss}>{statement.sql}</chakra.code>
      {risks && risks.length > 0 && (
        <Flex direction="column" gap="1" mt="1">
          {risks.map((r, i) => (
            <RiskBadge key={i} item={r} />
          ))}
        </Flex>
      )}
    </chakra.li>
  );
});

/**
 * 片側 (基準 / 更新先) の接続・DB の選択カード。見出しに役割 (「変更しない」/
 * 「ここが変わる」) を出し、書き換わる側 (`changes`) だけ警告色の枠で囲んで、
 * どちらが変わるのかを結果を見る前から分かるようにする。
 */
function SidePicker({
  label,
  hint,
  changes,
  side,
  state,
  profiles,
  onSelectProfile,
  onSelectDatabase,
  t,
}: {
  label: string;
  hint: string;
  /** SQL の適用で書き換わる側か (更新先)。 */
  changes: boolean;
  side: Side;
  state: SideState;
  profiles: ConnectionProfile[];
  onSelectProfile: (side: Side, profileId: string) => void;
  onSelectDatabase: (side: Side, database: string) => void;
  t: ReturnType<typeof useT>;
}) {
  const hintColor = changes ? semanticColorVar("warning", "text") : "var(--text-muted)";
  return (
    <Box
      css={sideCss}
      border="1px solid"
      borderColor={changes ? semanticColorVar("warning", "text") : "app.border"}
      borderRadius="lg"
      bg="app.surface"
      p="3"
    >
      <Flex align="center" gap="2">
        <chakra.span css={sideLabelCss}>{label}</chakra.span>
        <chakra.span
          fontSize="2xs"
          px="1.5"
          py="0.25"
          borderRadius="pill"
          border="1px solid"
          css={{ color: hintColor, borderColor: hintColor }}
        >
          {hint}
        </chakra.span>
      </Flex>
      <ListboxSelect
        ariaLabel={label}
        value={state.profileId ?? ""}
        options={[
          { value: "", label: t("schemaCompareSelectProfile") },
          ...profiles.map((p) => ({ value: p.id, label: p.name })),
        ]}
        onChange={(v) => onSelectProfile(side, v)}
        css={{ width: "100%" }}
      />
      <ListboxSelect
        ariaLabel={t("schemaCompareDatabaseOf", { side: label })}
        value={state.database ?? ""}
        options={[
          {
            value: "",
            label: state.connecting ? t("schemaCompareConnecting") : t("schemaCompareSelectDatabase"),
          },
          ...(state.databases ?? []).map((db) => ({ value: db })),
        ]}
        onChange={(v) => onSelectDatabase(side, v)}
        disabled={!state.databases || state.connecting}
        css={{ width: "100%" }}
      />
      {state.error && <chakra.span css={sideErrorCss}>{state.error}</chakra.span>}
    </Box>
  );
}
