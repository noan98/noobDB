import { createContext, forwardRef, memo, useCallback, useContext, useDeferredValue, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { findIdentityColumn } from "./identitySync";
import { isProtectedNamespace, treeNamespaceKind } from "./databaseMaintenance";
import { Box, chakra, Flex, Text, VisuallyHidden } from "@chakra-ui/react";
import { AnimatePresence, motion, Reorder } from "motion/react";
import { api, ConnectionProfile, IndexInfo, SandboxRecord, SchemaObject, SchemaTree, TableColumnInfo } from "../api/tauri";
import type { TableRef } from "../tableQuickAccess";
import { tableRefEquals } from "../tableQuickAccess";
import { isSandboxShadowTableName } from "../sandbox";
import { Callout } from "./Callout";
import { SandboxSection } from "./SandboxSection";
import { loadSchemaTree, saveSchemaTree } from "../schemaTreeState";
import { formatRowEstimate } from "./rowEstimate";
import { isRoutineKind, supportsRoutineExecution } from "./routineCall";
import { isEditableObjectKind, supportsRoutineEditing, type EditableObjectKind } from "./routineMaintenance";
import { useT } from "../i18n";
import { springs, transitions, variants } from "../motion";
import { beginTabOpenFlight, useTabOpenFlightFor } from "../sharedElement";
import { FlightIcon } from "./FlightIcon";
import { semanticColorVar } from "../semanticColors";
import { applyGroupOrder, applySubsequenceOrder, moveItemBy, reorderIfPermutation } from "../connectionOrder";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import {
  resolveTreeArrowLeft,
  resolveTreeArrowRight,
  resolveTreeMove,
  type TreeNavEntry,
} from "../treeKeyboardNav";
import {
  contextMenuTriggerFromRect,
  isContextMenuOpenKey,
  pickContextMenuOpenKeys,
  type ContextMenuTriggerEvent,
} from "./contextMenuKeyboard";
import { ICON_SIZES, Icon, type IconName } from "./Icon";
import { EmptyState } from "./EmptyState";
import { WelcomeIllustration } from "./illustrations";
import { SkeletonRow } from "./Skeleton";
import { ContextMenu, submenuOrFlat, type ContextMenuEntry } from "./ContextMenu";
import { isSynthesizedTableDdl } from "./tableDdl";
import { tableCommentMap, withComment } from "./schemaComment";
import { computeTooltipPosition, type TooltipRect } from "./tooltipPosition";
import { Tooltip, TooltipBubble, useDelegatedHover, useDelegatedTooltip } from "./Tooltip";
import { DropInsertionMarker } from "./DropInsertionMarker";
import { GroupAvatar, ProfileBadges } from "./ProfileBadge";
import { driverColor, driverIconName, normalizeChipColor } from "../profileIdentity";
import {
  databaseMaintenanceCommands,
  tableMaintenanceCommands,
  matviewRefreshCommands,
  type MaintenanceCommand,
  type MaintenanceKind,
} from "./maintenanceCommands";
import { Input } from "./ui";
import {
  buildExplorerRows,
  explorerContainerKind,
  explorerRowExpansion,
  explorerRowLabel,
  foreignKeyTargetLabel,
  isFocusableExplorerRow,
  partitionDatabaseNodes,
  tableKey,
  type ExplorerForeignKey,
  type ExplorerHeaderGroup,
  type ExplorerRow,
  type ExplorerViewNode,
} from "./explorerTree";
import type { I18nKey } from "../i18n";
import {
  MotionTreeRow,
  TreeBadge,
  TreeChevron,
  TreeChevronButton,
  TreeMoreButton,
  TreeCollapse,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeRow,
  TREE_GROUP_HEADING_PY,
} from "./tree";


/** `api.listTables` に薄く重ねて、サンドボックス (#747) の影テーブル
 *  (`db::sandbox::shadow_table_name` の予約プレフィックス) をツリー・検索・
 *  クイックアクセスなどこのコンポーネント内のあらゆる利用箇所から一律に隠す。
 *  非サンドボックスの通常セッションでは該当テーブルが存在しないため無害。 */
async function listVisibleTables(sessionId: string, db: string): Promise<string[]> {
  const list = await api.listTables(sessionId, db);
  return list.filter((t) => !isSandboxShadowTableName(t));
}

/** localStorage に永続化するグループ表示順序のキー (#786)。触られていない
 *  グループはアルファベット順の既定挙動のままなので、ドラッグ/キーボードで
 *  実際に動かした結果だけをここに書く (折りたたみ状態と同じ最小保存方針)。 */
const GROUP_ORDER_KEY = "noobdb.connlist.groupOrder";

/** localStorage から永続化済みグループ順序を復元する。SSR/未対応環境や
 *  パース失敗時は空 (= 全グループがアルファベット順になる、既存の既定挙動)。 */
function readGroupOrder(): string[] {
  try {
    const raw = localStorage.getItem(GROUP_ORDER_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((k): k is string => typeof k === "string");
  } catch {
    return [];
  }
}

/**
 * 接続プロファイル行 / グループ見出しブロックのドラッグ並べ替え (#786) 用の
 * `Reorder.Item` ラッパ。`TabBar` の `ReorderItemDiv`/`MotionTab` と同じ理由
 * (Chakra の `as` は `Reorder.Item` のロジックを消してしまうため) で `as="div"`
 * 固定の薄いラッパを噛ませてから chakra で装飾する。プロファイル行 (ヘッダ +
 * 展開中のスキーマサブツリー) とグループ見出しブロック (ヘッダ + 配下の
 * プロファイル群) の両方で共用する — どちらも「ヘッダ + 折りたたみ可能な子」の
 * 縦積みブロックという同じ形をしているため。
 */
const ReorderItemDiv = forwardRef<HTMLDivElement, React.ComponentProps<typeof Reorder.Item<string>>>(
  function ReorderItemDiv(props, ref) {
    // `layout="position"` が必須: Reorder.Item 既定の layout アニメーションは
    // サイズ変化も scale で FLIP させるため、ブロック内のサブツリー展開 (高さ変化)
    // のたびに内部の行が変形・移動し、直後のクリック/ダブルクリックが別要素へ
    // 当たってしまう (テーブル行の dblclick タブオープンが壊れる)。position 限定に
    // すると並べ替え時のスライドは維持しつつ、自身のサイズ変化では変形しない。
    return <Reorder.Item as="div" layout="position" ref={ref} {...props} />;
  },
);
const MotionReorderNode = chakra(
  ReorderItemDiv,
  { base: { display: "flex", flexDirection: "column" } },
  { forwardProps: ["transition"] },
);

/**
 * 現在開いているテーブル行を示すアクセントスパイン (#982)。`TabBar` の
 * アクティブインジケータ (`MotionIndicator`) と同じパターン
 * (`motion.span` + `forwardProps: ["transition"]`) をそのまま踏襲する新規の
 * Motion 基盤ではない薄いラッパで、ツリー全体で 1 つの `layoutId` を共有する。
 * アクティブなテーブル行が切り替わるたびに、前の行から新しい行へ spring で
 * 移動する (TabBar と同じ `transitions.emphasized`)。reduced-motion は
 * ルートの `<MotionConfig reducedMotion="user">` (src/main.tsx) が自動で
 * 即時化する。
 */
const MotionActiveIndicator = chakra(motion.span, {}, { forwardProps: ["transition"] });

/** サイドバーフィルタで公開するハンドル型。App.tsx が Cmd/Ctrl+P でフォーカスを当てるために使う。 */
export interface ConnectionListHandle {
  focusFilter: () => void;
  /** スキーマツリーをサーバーから再取得する (DDL 実行後の反映に使う)。 */
  refreshSchema: () => void;
}

/** 検索クエリ `query` にマッチする部分をハイライト表示するシンプルなコンポーネント。
 *  大小無視の部分一致で最初のマッチのみ強調し、マッチがなければそのまま返す。 */
function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const idx = lowerText.indexOf(query);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <chakra.mark
        bg="color-mix(in srgb, var(--accent) 35%, transparent)"
        color="inherit"
        borderRadius="xs"
        px="0.25"
      >
        {text.slice(idx, idx + query.length)}
      </chakra.mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/** 保守コマンド種別ごとのメニューラベル i18n キー。#561。 */
const MAINTENANCE_LABEL_KEYS: Record<MaintenanceKind, I18nKey> = {
  analyze: "maintenanceAnalyze",
  optimize: "maintenanceOptimize",
  check: "maintenanceCheck",
  repair: "maintenanceRepair",
  vacuum: "maintenanceVacuum",
  vacuumAnalyze: "maintenanceVacuumAnalyze",
  reindex: "maintenanceReindex",
  refreshMatview: "maintenanceRefreshMatview",
  refreshMatviewConcurrently: "maintenanceRefreshMatviewConcurrently",
};

/** 接続リストのグループ折りたたみ状態を永続化する localStorage キー。
 *  既定はすべて展開なので、明示的に「閉じている」グループ key の配列だけを保存する。 */
const COLLAPSED_GROUPS_KEY = "noobdb.connlist.collapsedGroups";

/** localStorage から閉じているグループ集合を復元し、`expandedGroups` の初期値
 *  ({ key: false } の Record) に変換する。SSR/未対応環境やパース失敗時は空。 */
function readCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return {};
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return {};
    const out: Record<string, boolean> = {};
    for (const k of arr) if (typeof k === "string") out[k] = false;
    return out;
  } catch {
    return {};
  }
}

/** ネストした子ノードを包む破線インデント。 */
const TreeChildren = chakra("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    pl: "3",
    ml: "3.5",
    borderLeft: "1px dashed",
    borderColor: "app.border",
  },
});

/** ローディング / 空表示のプレースホルダ行。 */
const TreeEmpty = chakra("div", {
  base: {
    pt: "1",
    pb: "1",
    pr: "2.5",
    pl: "22px",
    fontSize: "xs",
    color: "app.textMuted",
    fontStyle: "italic",
  },
});

// クイックアクセスのセクション見出し (お気に入り / 最近)。
const QuickAccessHeader = chakra("div", {
  base: { pt: "1.5", pb: "0.5", pl: "2", pr: "2.5", textStyle: "overline" },
});

/** 接続状態ドットの状態別 style。色は動的トークンの
 *  ため CSS 変数を直接参照する。`connecting` の脈動は App.css の @keyframes pulse。 */
const STATUS_DOT_STYLE = {
  idle: {
    bg: "var(--status-idle)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-idle) 18%, transparent)",
  },
  connected: {
    bg: "var(--status-connected)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-connected) 25%, transparent)",
  },
  connecting: {
    bg: "var(--status-connecting)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-connecting) 25%, transparent)",
    animation: "pulse 1.2s ease-in-out infinite",
  },
  error: {
    bg: "var(--status-error)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--status-error) 25%, transparent)",
  },
} as const;

interface Props {
  profiles: ConnectionProfile[];
  activeProfileId: string | null;
  /**
   * 現在アクティブなタブが開いている (database, table)。table タブ以外
   * (query/explain) や未接続時は null。一致するスキーマツリーの行に
   * `aria-current` + アクセントスパインを付与する「現在地」表示 (#982) に使う。
   */
  activeTable?: { database: string; table: string } | null;
  sessionId: string | null;
  connectingId: string | null;
  errorProfileId: string | null;
  /**
   * Profile ids that currently have a live backend session (the active one and
   * any others kept open in the background). Used to mark them as connected and
   * to switch to them instantly instead of reconnecting. (#複数同時接続)
   */
  openProfileIds?: ReadonlySet<string>;
  onConnect: (profile: ConnectionProfile) => void;
  /** Close a specific background (or active) connection without reconnecting. */
  onDisconnectProfile?: (profileId: string) => void;
  /**
   * Drag/keyboard reorder of connections (#786). Called with the new order of
   * every id present in the `profiles` prop (a true permutation of
   * `profiles.map(p => p.id)`) — the caller is responsible for embedding this
   * back into the full backend order (e.g. when `profiles` is itself a filtered
   * view) and persisting it via `api.reorderProfiles`. Omitted disables both
   * drag and keyboard reorder (profiles render statically, as before #786).
   */
  onReorderProfiles?: (orderedIds: string[]) => void;
  onCreate: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  /** Passes the full profile (not just id) so the caller can offer an Undo (#676). */
  onDelete: (profile: ConnectionProfile) => void;
  onPickTable: (database: string, table: string) => void;
  /**
   * テーブル / ビューの構造 (列・インデックス・外部キー) をボトムパネルで開く (#1112)。
   * データ (`onPickTable`) と並ぶテーブル選択後のもう一方の行き先。未指定なら
   * メニュー項目を出さない。
   */
  onOpenStructure?: (database: string, table: string) => void;
  onImportTable: (database: string, table: string) => void;
  /** テーブルを別接続へスキーマ + データごとコピーする (#986)。読み取りなので read_only でも有効。 */
  onTransferTable?: (database: string, table: string) => void;
  /** ファイルから新規テーブルを作成してインポートする (#985)。read_only では無効化。 */
  onImportNewTable?: (database: string) => void;
  /** スキーマに基づくテストデータ生成ウィザードを開く (#602)。read_only では無効化。 */
  onGenerateTestData?: (database: string, table: string) => void;
  /** テーブルを開いたときのデフォルトクエリ (テーブル別、#1253) を設定する。 */
  onConfigureOpenQuery?: (database: string, table: string) => void;
  onDumpDatabase: (database: string) => void;
  /** `.sql` ファイルをこの DB のコンテキストでストリーミング実行するモーダルを開く (#973)。 */
  onRunScript?: (database: string) => void;
  /** DB スキーマを AI 向け Markdown としてエクスポートするモーダルを開く。 */
  onSchemaExport?: (database: string) => void;
  onRunTableSelect: (database: string, table: string) => void;
  onInsertTableSelect: (database: string, table: string) => void;
  /** テーブルの CREATE TABLE DDL を新しいクエリタブに表示する (#1001)。全ドライバ対応
   *  (`get_object_definition` の kind = "table")。読み取りのみなので read_only でも有効。 */
  onShowCreateTable?: (database: string, table: string) => void;
  /** テーブルの CREATE TABLE DDL をクリップボードへコピーする (#1001)。 */
  onCopyTableDdl?: (database: string, table: string) => void;
  /** DB ノードから新規テーブル作成ウィザードを開く。 */
  onCreateTable?: (database: string) => void;
  /** テーブル保守操作: TRUNCATE / DROP / RENAME / 列編集 (#794)。read_only では無効化される。 */
  onTruncateTable?: (database: string, table: string) => void;
  onDropTable?: (database: string, table: string) => void;
  onRenameTable?: (database: string, table: string) => void;
  /** 列の追加/変更/削除/リネームとインデックス作成の GUI ダイアログを開く (#794)。read_only では無効化。 */
  onAlterTable?: (database: string, table: string) => void;
  /** テーブル右クリックからインデックス作成の軽量モーダルを開く (#850)。`AlterTable`
   *  の重量フォームを開かずに済む単一目的の近道。read_only では無効化。 */
  onCreateIndex?: (database: string, table: string) => void;
  /** インデックスノード右クリックからの DROP INDEX (#850)。方言別 SQL の生成は
   *  `tableMaintenance.ts::buildDropIndexSql` (`db/advisor.rs::drop_index_ddl` の移植)。
   *  read_only では無効化、PK インデックスはツリー側で対象外にする。 */
  onDropIndex?: (database: string, table: string, indexName: string) => void;
  /** テーブル保守コマンド (ANALYZE / OPTIMIZE / VACUUM / REINDEX 等)。#561。
   *  生成済み SQL を渡し、確認 + 実行は呼び出し側 (App) が担う。read_only では無効化。 */
  onRunTableMaintenance?: (database: string, table: string, command: MaintenanceCommand) => void;
  /** DB 全体の保守コマンド (SQLite VACUUM / PostgreSQL VACUUM・ANALYZE 等)。#561。 */
  onRunDatabaseMaintenance?: (database: string, command: MaintenanceCommand) => void;
  /** 採番列の現在値を実データに同期する (#1240)。対象列は App が再判定する。 */
  onSyncIdentity?: (database: string, table: string) => void;
  /** データベース / スキーマの新規作成モーダルを開く (#1190)。プロファイルと DB ノードの
   *  右クリックから呼ぶ。SQLite は非対応なので項目を出さない。read_only では無効化。 */
  onCreateNamespace?: () => void;
  /** DB ノード (MySQL = データベース / PostgreSQL = スキーマ) の DROP (#1190)。名前の
   *  タイプ入力確認は呼び出し側 (App) が挟む。read_only では無効化。 */
  onDropNamespace?: (name: string) => void;
  /** DB ノードからサイズ・統計ダッシュボードを開く。#562。 */
  onShowDatabaseSizes?: (database: string) => void;
  /** テーブルノードから列データプロファイル (「列を探索」) を開く。#974。 */
  onExploreColumns?: (database: string, table: string) => void;
  /** テーブルノードからテーブル・タイムラプス (#739) のウォッチ登録を始める。
   *  読み取りの SELECT だけなので read_only でも有効。 */
  onWatchTable?: (database: string, table: string) => void;
  /** DB ノードからサンドボックス (壊せる砂場) 作成ダイアログを開く。#747。 */
  onCreateSandbox?: (database: string) => void;
  /** 作成済みサンドボックス一覧 (#747)。専用セクションとして通常のプロファイル
   *  ツリーとは別に描画する (`SandboxSection`)。 */
  sandboxes?: SandboxRecord[];
  onOpenSandbox?: (record: SandboxRecord) => void;
  onReviewSandbox?: (record: SandboxRecord) => void;
  onDiscardSandbox?: (record: SandboxRecord) => void;
  /** テーブル名をクリップボードへコピー。 */
  onCopyTableName?: (table: string) => void;
  /**
   * 列をエディタへ挿入する (#1352)。`qualified` なら `表.列`、そうでなければ列名のみ。
   * 列のコンテキストメニューとダブルクリックから呼ぶ。未指定なら挿入項目を出さない。
   */
  onInsertColumn?: (database: string, table: string, column: string, qualified: boolean) => void;
  /** 列名をクリップボードへコピーする (#1352)。未指定ならメニュー項目を出さない。 */
  onCopyColumnName?: (column: string) => void;
  /** スキーマオブジェクトの定義を開く。`id` は同名衝突を避ける一意識別子。 */
  onOpenObjectDefinition?: (database: string, kind: string, name: string, id: string | null) => void;
  /**
   * ビュー定義の編集 (#851): 右クリックメニューから、既存ビューの本文をエディタへ
   * 展開する (`get_object_definition` → `CREATE OR REPLACE VIEW` で置換保存する
   * 導線は App 側の `SaveAsViewModal` が担う)。未指定ならメニュー項目を出さない。
   */
  onEditViewDefinition?: (database: string, name: string) => void;
  /** ビューの DROP (#851)。テーブルの `onDropTable` と同じ確認導線を流用する。
   *  read_only では無効化される。 */
  onDropView?: (database: string, name: string) => void;
  /**
   * ストアドプロシージャ / 関数の実行フォーム (#1003) を開く。右クリックメニューの
   * 「実行...」から呼ぶ。SQLite (ルーチン非対応) では項目を無効化する。
   * 未指定ならメニュー項目を出さない。
   */
  onRunRoutine?: (database: string, kind: "procedure" | "function", name: string, id: string | null) => void;
  /**
   * ルーチン / トリガーの定義編集 (#1192)。右クリックの「定義を編集...」から呼ぶ。
   * ドライバが対応しない種別 (SQLite のルーチン) や read_only では項目を無効化する。
   * 未指定ならメニュー項目を出さない。
   */
  onEditRoutine?: (database: string, kind: EditableObjectKind, name: string, id: string | null) => void;
  /** ルーチン / トリガーの新規作成 (#1192)。DB の右クリックメニューから呼ぶ。 */
  onCreateRoutine?: (database: string, kind: EditableObjectKind) => void;
  /**
   * 影響分析 (#1027): テーブル / ビュー / 列を参照している定義・スニペットを
   * ボトムパネルで検索する。`column` が null ならテーブル (ビュー) 自体。読み取りの
   * introspection だけなので read_only でも有効。未指定ならメニュー項目を出さない。
   */
  onFindUsages?: (database: string, table: string, column: string | null) => void;
  /** Row cap shown in the "Run SELECT *" menu label. */
  selectLimit: number;
  /** お気に入りテーブル (アクティブ接続) のクイックアクセス。 */
  favorites?: TableRef[];
  /** 最近開いたテーブル (アクティブ接続) のクイックアクセス。 */
  recent?: TableRef[];
  /** お気に入りのトグル (登録/解除)。未指定ならお気に入り UI を出さない。 */
  onToggleFavorite?: (database: string, table: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

// --- スキーマツリーの行 (#1314) ---
//
// ツリーは数百〜数千行になりうるので、行ごとに `memo` コンポーネントへ切り出し、
// 「その行の props が変わったときだけ」描き直す。行が共有するハンドラ・ツールチップ・
// roving tabindex の状態は `TreeActionsContext` の安定した 1 オブジェクトで受け取る
// (中身の関数は `ConnectionList` が ref 経由で最新に保つので、行の props には載せない)。

/** ツリー全体で「今 Tab で止まる 1 行」(roving tabindex, #1184) の外部ストア。
 *  フォーカス移動のたびに `ConnectionList` 本体や全行を描き直さないよう、state ではなく
 *  ストアに置き、各行が自分のキーと一致するかだけを購読する (値が変わる 2 行だけが
 *  再レンダーされる)。 */
interface TabStopStore {
  get: () => string | null;
  set: (key: string | null) => void;
  subscribe: (listener: () => void) => () => void;
  has: (key: string) => boolean;
  /** マウント中の行を登録する。戻り値はアンマウント時の解除関数で、止まり先の行が
   *  消えたときはストアを空 (null) に戻して `ConnectionList` に再選出を促す。 */
  register: (key: string) => () => void;
}

function createTabStopStore(): TabStopStore {
  let current: string | null = null;
  const listeners = new Set<() => void>();
  const keys = new Map<string, number>();
  const notify = () => {
    for (const l of Array.from(listeners)) l();
  };
  return {
    get: () => current,
    set: (key) => {
      if (key === current) return;
      current = key;
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    has: (key) => keys.has(key),
    register: (key) => {
      keys.set(key, (keys.get(key) ?? 0) + 1);
      if (current === null) notify();
      return () => {
        const n = (keys.get(key) ?? 1) - 1;
        if (n <= 0) keys.delete(key);
        else keys.set(key, n);
        if (n <= 0 && current === key) {
          current = null;
          notify();
        }
      };
    },
  };
}

type HoverHandlers = {
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => void;
};

/** 共有ツールチップ (`useDelegatedTooltip` / `useDelegatedHover`) の `bind`。 */
type HoverBind<V> = (value: V | undefined | null) => HoverHandlers | undefined;

/** ツリー全体の行が共有するハンドラ群。`ConnectionList` が 1 度だけ作り、以後は同一参照。 */
interface TreeActions {
  store: TabStopStore;
  treeTooltip: HoverBind<string>;
  columnTooltip: HoverBind<TableColumnInfo>;
  makeKeyDown: (
    activate?: () => void,
    openContextMenu?: (e: ContextMenuTriggerEvent) => void,
  ) => (e: React.KeyboardEvent<HTMLElement>) => void;
  pickTable: (db: string, tbl: string) => void;
  toggleTable: (db: string, tbl: string) => void;
  toggleFavorite: (db: string, tbl: string) => void;
  openObjectDefinition: (db: string, kind: string, name: string, id: string | null) => void;
  tableMenu: (e: ContextMenuTriggerEvent, db: string, tbl: string) => void;
  viewMenu: (e: ContextMenuTriggerEvent, db: string, view: ExplorerViewNode, asNode?: boolean) => void;
  routineMenu: (e: ContextMenuTriggerEvent, db: string, o: SchemaObject) => void;
  columnMenu: (e: ContextMenuTriggerEvent, db: string, tbl: string, column: string) => void;
  insertColumn: (db: string, tbl: string, column: string) => void;
  indexMenu: (e: ContextMenuTriggerEvent, db: string, tbl: string, idx: IndexInfo) => void;
  toggleDb: (db: string) => void;
  dbMenu: (e: ContextMenuTriggerEvent, db: string) => void;
  activeTableIndicatorId: string;
}

const TreeActionsContext = createContext<TreeActions | null>(null);

function useTreeActions(): TreeActions {
  const actions = useContext(TreeActionsContext);
  if (!actions) throw new Error("TreeActionsContext の外でスキーマツリーの行を描画した");
  return actions;
}

/** 呼び出し側が毎回新しい関数を作っても、返す関数の参照は変わらない (最新の関数へ委譲)。 */
function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/** 1 行ぶんの roving tabindex: `tabIndex` と、フォーカスが行そのものに入ったとき
 *  (子要素からのバブリングは無視) にストアを更新する `onFocus`。マウスクリックでも
 *  `focus()` は発火するので、クリック操作からも自然に追従する。 */
function useTabStop(store: TabStopStore, key: string) {
  const tabIndex = useSyncExternalStore(
    store.subscribe,
    () => (store.get() === key ? 0 : -1),
  );
  useLayoutEffect(() => store.register(key), [store, key]);
  const onFocus = useCallback(
    (e: React.FocusEvent<HTMLElement>) => {
      if (e.target === e.currentTarget) store.set(key);
    },
    [store, key],
  );
  return { tabIndex, onFocus };
}

/** `memo` 化していない行 (プロファイル / グループ見出し / DB) に roving tabindex を
 *  与える render-prop。フォーカス移動で再レンダーされるのはこの小さな枠だけ。 */
function TabStop({
  treeKey,
  children,
}: {
  treeKey: string;
  children: (stop: { tabIndex: number; onFocus: (e: React.FocusEvent<HTMLElement>) => void }) => React.ReactElement;
}) {
  const actions = useTreeActions();
  return children(useTabStop(actions.store, treeKey));
}

type TooltipBindRef<V> = { current: HoverBind<V> | null };

/** 行へ渡す `bind` を、ツールチップの状態を持つ `*Layer` から切り離すための安定ラッパー。
 *  ホバー状態が変わっても行 (と `ConnectionList`) は描き直されず、層だけが再レンダーされる。
 *  実際のハンドラはイベント時点の最新の `bind` へ委譲する。 */
function useLazyBind<V>(ref: TooltipBindRef<V>): HoverBind<V> {
  return useCallback(
    (value) => {
      if (value === undefined || value === null || (value as unknown) === "") return undefined;
      return {
        onMouseEnter: (e) => ref.current?.(value)?.onMouseEnter(e),
        onMouseLeave: (e) => ref.current?.(value)?.onMouseLeave(e),
      };
    },
    [ref],
  );
}

/** ツリー行の単純テキストツールチップ (1 つの共有バブル + イベント委譲、#884)。 */
function TreeTooltipLayer({ bindRef }: { bindRef: TooltipBindRef<string> }) {
  const { hovered, bind } = useDelegatedTooltip();
  bindRef.current = bind;
  return hovered ? <TooltipBubble label={hovered.label} anchor={hovered.rect} maxWidth="320px" /> : null;
}

/** カラム行の詳細ホバーカード (`ColumnTooltip`)。 */
function ColumnTooltipLayer({ bindRef }: { bindRef: TooltipBindRef<TableColumnInfo> }) {
  const { hovered, bind } = useDelegatedHover<TableColumnInfo>();
  bindRef.current = bind;
  return hovered ? <ColumnTooltip col={hovered.value} anchor={hovered.rect} /> : null;
}

/** ローディングのスケルトン行。 */
// スケルトン幅: 視覚的なランダム感を演出するために固定幅サイクルを使う。
const SKELETON_ROW_WIDTHS = [72, 58, 85, 65, 78];

function LoadingRow() {
  const t = useT();
  return (
    // スケルトンノード: Spinner + テキストの代わりに、ツリー行の構造をシマーで
    // 予兆表示する。シマー自体は内容のないプレースホルダなので `aria-hidden` で
    // 支援技術から隠しつつ、`role="status"` + 視覚的に隠したテキストで
    // 「ロード中」であることはスクリーンリーダーへ通知する。
    <div role="status" aria-live="polite">
      <VisuallyHidden>{t("treeLoading")}</VisuallyHidden>
      <div aria-hidden>
        {SKELETON_ROW_WIDTHS.map((w, i) => (
          <SkeletonRow
            key={i}
            style={{ width: `${w}%`, animationDelay: `${i * 0.1}s`, opacity: 1 - i * 0.15 }}
          />
        ))}
      </div>
    </div>
  );
}

/** 行末の「…」ボタン (#1269)。右クリックと同じメニュー組み立て関数 `onOpen` を、
 *  ボタンの左下を起点にして開く (キーボードの Shift+F10 と同じアンカー規則)。 */
function TreeMoreActions({ onOpen }: { onOpen: (e: ContextMenuTriggerEvent) => void }) {
  const t = useT();
  const actions = useTreeActions();
  return (
    <TreeMoreButton
      type="button"
      data-tree-more=""
      tabIndex={-1}
      aria-label={t("treeMoreActionsAria")}
      aria-haspopup="menu"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(contextMenuTriggerFromRect(e.currentTarget.getBoundingClientRect()));
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      {...actions.treeTooltip(t("treeMoreActionsAria"))}
    >
      <Icon name="more" size={ICON_SIZES.sm} />
    </TreeMoreButton>
  );
}

// クイックアクセス: アクティブ接続の databases の上に「お気に入り」「最近」を
// 並べ、ワンクリックで開けるようにする。各行は db.table を表示し、`pickTable` で開く。
const QuickAccessRow = memo(function QuickAccessRow({
  refItem,
  kind,
  level,
  posInSet,
  setSize,
  removable,
}: {
  refItem: TableRef;
  kind: "favorite" | "recent";
  /** `groupLevel` (グループ見出しがあるとき 1)。 */
  level: number;
  posInSet?: number;
  setSize?: number;
  /** お気に入り行に「解除」ボタンを出すか (トグル用ハンドラがあるとき)。 */
  removable: boolean;
}) {
  const t = useT();
  const actions = useTreeActions();
  const star = kind === "favorite";
  const key = `qa:${kind}:${tableKey(refItem.database, refItem.table)}`;
  const { tabIndex, onFocus } = useTabStop(actions.store, key);
  const activate = () => actions.pickTable(refItem.database, refItem.table);
  const openMenu = (e: ContextMenuTriggerEvent) => actions.tableMenu(e, refItem.database, refItem.table);
  return (
    <TreeRow
      data-tree-key={key}
      pl="1"
      role="treeitem"
      aria-level={level + 2}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={actions.makeKeyDown(activate, openMenu)}
      onClick={activate}
      onContextMenu={openMenu}
      {...actions.treeTooltip(`${refItem.database}.${refItem.table}`)}
      _hover={{ bg: "app.rowHover" }}
    >
      <TreeChevron aria-hidden style={{ visibility: "hidden" }}>▸</TreeChevron>
      <TreeIcon color={star ? "app.favorite" : "app.textSecondary"} aria-hidden>
        <Icon name={star ? "star-filled" : "clock"} />
      </TreeIcon>
      <TreeLabel fontWeight={400}>
        {refItem.table}
        <chakra.span color="app.textMuted" fontSize="2xs" ml="1.5">
          {refItem.database}
        </chakra.span>
      </TreeLabel>
      {star && removable && (
        <Tooltip label={t("quickAccessRemoveTitle")}>
          <chakra.button
            type="button"
            aria-label={t("quickAccessRemoveTitle")}
            onClick={(e) => {
              e.stopPropagation();
              actions.toggleFavorite(refItem.database, refItem.table);
            }}
            color="app.textMuted"
            px="1"
            _hover={{ color: "app.text" }}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </chakra.button>
        </Tooltip>
      )}
    </TreeRow>
  );
});

const SCHEMA_OBJECT_ICONS: Record<string, IconName> = {
  view: "view",
  materialized_view: "view",
  procedure: "routine",
  function: "routine",
  trigger: "trigger",
};

/** 非テーブルのスキーマオブジェクト (ルーチン / トリガー / 突き合わなかったビュー) の 1 行。
 *  選択すると `openObjectDefinition` で定義 DDL を開く。 */
const SchemaObjectRow = memo(function SchemaObjectRow({
  db,
  o,
  kindLabel,
  level,
  posInSet,
  setSize,
  q,
}: {
  db: string;
  o: SchemaObject;
  kindLabel: string;
  level: number;
  posInSet?: number;
  setSize?: number;
  q: string;
}) {
  const actions = useTreeActions();
  const kind = o.kind;
  const key = `so:${db}:${kind}:${o.name}:${o.id ?? ""}`;
  const { tabIndex, onFocus } = useTabStop(actions.store, key);
  const activate = () => actions.openObjectDefinition(db, o.kind, o.name, o.id);
  const openMenu: ((ev: ContextMenuTriggerEvent) => void) | undefined =
    kind === "view"
      ? (ev) => actions.viewMenu(ev, db, { name: o.name, kind: "view", id: o.id }, false)
      : isEditableObjectKind(kind)
        ? (ev) => actions.routineMenu(ev, db, o)
        : undefined;
  return (
    <TreeRow
      data-tree-key={key}
      pl="1"
      role="treeitem"
      aria-level={level + 3}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={actions.makeKeyDown(activate, openMenu)}
      onClick={activate}
      onContextMenu={openMenu}
      {...actions.treeTooltip(`${o.name} — ${kindLabel}`)}
      _hover={{ bg: "app.rowHover" }}
    >
      <TreeChevron visibility="hidden" aria-hidden />
      <TreeIcon color="app.textSecondary" aria-hidden>
        <Icon name={SCHEMA_OBJECT_ICONS[kind] ?? "query"} />
      </TreeIcon>
      <TreeLabel fontWeight={400}>
        <HighlightText text={o.name} query={q} />
      </TreeLabel>
    </TreeRow>
  );
});

const ColumnRow = memo(function ColumnRow({
  db,
  tbl,
  col,
  level,
  posInSet,
  setSize,
  q,
}: {
  db: string;
  tbl: string;
  col: TableColumnInfo;
  level: number;
  posInSet?: number;
  setSize?: number;
  q: string;
}) {
  const actions = useTreeActions();
  const isPk = col.key === "PRI";
  const isFk = col.referenced_table !== null;
  const colKey = `col:${tableKey(db, tbl)}:${col.name}`;
  const { tabIndex, onFocus } = useTabStop(actions.store, colKey);
  const openMenu = (e: ContextMenuTriggerEvent) => actions.columnMenu(e, db, tbl, col.name);
  return (
    <TreeRow
      data-tree-key={colKey}
      pt="0.75"
      pb="0.75"
      cursor="default"
      fontSize="sm"
      role="treeitem"
      aria-level={level + 4}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={actions.makeKeyDown(undefined, openMenu)}
      onContextMenu={openMenu}
      onDoubleClick={() => actions.insertColumn(db, tbl, col.name)}
      {...actions.columnTooltip(col)}
    >
      <TreeChevron visibility="hidden" aria-hidden />
      {/* PK/FK アイコンと型バッジの native title は削除(#884)。行に
          hover すると `ColumnTooltip` (`ColumnTooltipLayer`) が
          鍵種別・型を含む詳細を表示するため、ここで別に native
          title を持つと同じ情報が二重に (かつ約 1 秒遅れで)
          出てしまう。 */}
      <TreeIcon
        fontSize="xs"
        color={isPk ? "app.keyAccent" : isFk ? "app.accent" : "app.textMuted"}
        aria-hidden
      >
        {isPk ? <Icon name="key" /> : isFk ? <Icon name="link" /> : "·"}
      </TreeIcon>
      <TreeLabel fontFamily="mono" color="app.text"><HighlightText text={col.name} query={q} /></TreeLabel>
      <TreeBadge
        fontFamily="mono"
        textTransform="lowercase"
        fontSize="2xs"
      >
        {col.data_type}
      </TreeBadge>
    </TreeRow>
  );
});

const IndexRow = memo(function IndexRow({
  db,
  tbl,
  idx,
  level,
  posInSet,
  setSize,
}: {
  db: string;
  tbl: string;
  idx: IndexInfo;
  level: number;
  posInSet?: number;
  setSize?: number;
}) {
  const t = useT();
  const actions = useTreeActions();
  const idxKey = `idx:${tableKey(db, tbl)}:${idx.name}`;
  const { tabIndex, onFocus } = useTabStop(actions.store, idxKey);
  const openMenu = (e: ContextMenuTriggerEvent) => actions.indexMenu(e, db, tbl, idx);
  return (
    <TreeRow
      data-tree-key={idxKey}
      pt="0.75"
      pb="0.75"
      cursor="default"
      fontSize="sm"
      role="treeitem"
      aria-level={level + 4}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={actions.makeKeyDown(undefined, openMenu)}
      onContextMenu={openMenu}
      {...actions.treeTooltip(
        `${idx.name}${idx.method ? ` (${idx.method})` : ""}: ${idx.columns.join(", ")}`,
      )}
    >
      <TreeChevron visibility="hidden" aria-hidden />
      <TreeIcon
        fontSize="xs"
        color={idx.primary ? "app.keyAccent" : idx.unique ? "app.status.success" : "app.textMuted"}
        aria-hidden
      >
        {idx.primary ? <Icon name="key" /> : <Icon name="list" />}
      </TreeIcon>
      <TreeLabel fontFamily="mono" color="app.text">
        {idx.columns.join(", ") || idx.name}
      </TreeLabel>
      {(idx.primary || idx.unique) && (
        <TreeBadge
          fontSize="2xs"
          textTransform="uppercase"
          {...actions.treeTooltip(idx.name)}
        >
          {idx.primary ? t("indexBadgePk") : t("indexBadgeUnique")}
        </TreeBadge>
      )}
    </TreeRow>
  );
});

const ForeignKeyRow = memo(function ForeignKeyRow({
  db,
  tbl,
  fk,
  level,
  posInSet,
  setSize,
}: {
  db: string;
  tbl: string;
  fk: ExplorerForeignKey;
  level: number;
  posInSet?: number;
  setSize?: number;
}) {
  const t = useT();
  const actions = useTreeActions();
  const fkKey = `fk:${tableKey(db, tbl)}:${fk.column}`;
  const { tabIndex, onFocus } = useTabStop(actions.store, fkKey);
  const activate = () => actions.pickTable(db, fk.referencedTable);
  return (
    <TreeRow
      data-tree-key={fkKey}
      pt="0.75"
      pb="0.75"
      fontSize="sm"
      role="treeitem"
      aria-level={level + 4}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-label={`${fk.column} → ${foreignKeyTargetLabel(fk)}`}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={actions.makeKeyDown(activate)}
      onClick={activate}
      {...actions.treeTooltip(t("treeFkOpenHint", { table: fk.referencedTable }))}
      _hover={{ bg: "app.rowHover" }}
    >
      <TreeChevron visibility="hidden" aria-hidden />
      <TreeIcon fontSize="xs" color="app.accent" aria-hidden>
        <Icon name="link" />
      </TreeIcon>
      <TreeLabel fontFamily="mono" color="app.text">
        {fk.column}
        <chakra.span color="app.textMuted"> → {foreignKeyTargetLabel(fk)}</chakra.span>
      </TreeLabel>
    </TreeRow>
  );
});

interface TableNodeProps {
  db: string;
  tbl: string;
  /** ビューなら振り分け結果のノード、テーブルなら null。 */
  view: ExplorerViewNode | null;
  /** 検索クエリ (小文字化済み)。 */
  q: string;
  /** `groupLevel` (グループ見出しがあるとき 1)。 */
  level: number;
  /** 子 (列・インデックス・外部キー) を展開しているか。 */
  open: boolean;
  rowEst: number | null | undefined;
  comment: string | undefined;
  /** 現在結果パネルに開いているテーブルか (#982)。 */
  isActive: boolean;
  posInSet?: number;
  setSize?: number;
}

/**
 * テーブル / ビューの 1 行 (#1112)。ビューもテーブルと同じく列・インデックス・
 * 外部キーを展開でき、ダブルクリックでデータを開く。展開したときの子は、この行の中ではなく
 * 別の行としてフラットな配列に並ぶ (`buildExplorerRows`、仮想化のため #1315)。
 *
 * `memo` 化しているので、props (自分のテーブルの状態) が変わらない限り、ほかの行の
 * フォーカス・ホバー・検索入力・ストリーミングでは描き直されない (#1314)。
 */
const TableNode = memo(function TableNode({
  db,
  tbl,
  view,
  q,
  level,
  open: tOpen,
  rowEst,
  comment,
  isActive: isActiveTable,
  posInSet,
  setSize,
}: TableNodeProps) {
  const t = useT();
  const actions = useTreeActions();
  const tKey = tableKey(db, tbl);
  // 新規タブを開く飛行中だけ行のアイコンが layoutId を持つ (#1415)。
  const openFlight = useTabOpenFlightFor(db, tbl);
  const treeKey = `tbl:${tKey}`;
  const { tabIndex, onFocus } = useTabStop(actions.store, treeKey);
  const rowEstLabel = typeof rowEst === "number" ? formatRowEstimate(rowEst) : "";
  const openMenu = (e: ContextMenuTriggerEvent) =>
    view ? actions.viewMenu(e, db, view) : actions.tableMenu(e, db, tbl);

  return (
    <TreeRow
      data-tree-key={treeKey}
      pl="1"
      role="treeitem"
      /* 行のアクセシブルネームをテーブル名に固定する。既定の
         content 由来の名前だと、内側のチェブロンボタンの
         aria-label や行数バッジまで連結され、SR の読み上げと
         ロール検索 (テスト含む) が不安定になるため。 */
      aria-label={tbl}
      aria-level={level + 3}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-expanded={tOpen}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={actions.makeKeyDown(() => actions.pickTable(db, tbl), openMenu)}
      // 「現在地」表示 (#982): SR には aria-current、視覚には
      // 下の共有 layoutId インジケータ (アクセントスパイン) で
      // 示す。position: relative はインジケータの絶対配置の
      // 基準になるが、非アクティブ行では不要なので付けない。
      aria-current={isActiveTable ? "true" : undefined}
      position={isActiveTable ? "relative" : undefined}
      bg={isActiveTable ? "var(--bg-active)" : undefined}
      onDoubleClick={() => {
        // ダブルクリックで開くときだけ、行のアイコンが新規タブへ morph する (#1415)。
        beginTabOpenFlight(db, tbl);
        actions.pickTable(db, tbl);
      }}
      onContextMenu={openMenu}
      {...actions.treeTooltip(withComment(t("treeTableTitle"), comment))}
      _hover={{ bg: isActiveTable ? "var(--bg-active)" : "app.rowHover" }}
    >
      {isActiveTable && (
        <MotionActiveIndicator
          layoutId={actions.activeTableIndicatorId}
          transition={transitions.emphasized}
          position="absolute"
          left="0"
          top="0"
          bottom="0"
          width="2px"
          bg="var(--accent)"
          aria-hidden
        />
      )}
      {/* カラム展開のトグルはチェブロンのみ。行クリックに置くと
          ダブルクリック (テーブルを開く) の前に click が 2 回発火して
          カラム一覧まで同時に開いてしまう。stopPropagation はチェブロンの
          連打が行の onDoubleClick (テーブルを開く) に化けるのを防ぐ。
          マウスでは唯一の展開手段になったためネイティブ button として描画し、
          キーボード (Enter/Space) と支援技術からも操作できるようにする。
          行本体からの ArrowRight/ArrowLeft (#1184) も、この button の
          aria-expanded を目印にここをクリックしてトグルする
          (`makeTreeItemKeyDown` 参照)。 */}
      <TreeChevronButton
        type="button"
        transform={tOpen ? "rotate(90deg)" : undefined}
        aria-label={t("treeToggleColumnsAria", { table: tbl })}
        aria-expanded={tOpen}
        onClick={(e) => {
          e.stopPropagation();
          actions.toggleTable(db, tbl);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >▸</TreeChevronButton>
      <TreeIcon color="app.textSecondary" aria-hidden>
        <FlightIcon flightId={openFlight}>
          <Icon name={view ? "view" : "table"} />
        </FlightIcon>
      </TreeIcon>
      <TreeLabel fontWeight={400}><HighlightText text={tbl} query={q} /></TreeLabel>
      {rowEstLabel && (
        <TreeBadge
          fontFamily="mono"
          fontSize="2xs"
          textTransform="none"
          letterSpacing="0"
          {...actions.treeTooltip(`${rowEst!.toLocaleString()} — ${t("treeRowEstimateTitle")}`)}
        >
          {rowEstLabel}
        </TreeBadge>
      )}
      <TreeMoreActions onOpen={openMenu} />
    </TreeRow>
  );
});

/** データベース (PostgreSQL ではスキーマ) の 1 行。展開すると配下のテーブルが続く行になる (#1315)。 */
const DbRow = memo(function DbRow({
  db,
  open,
  level,
  q,
  containerLabel,
  posInSet,
  setSize,
}: {
  db: string;
  open: boolean;
  level: number;
  q: string;
  containerLabel: string;
  posInSet?: number;
  setSize?: number;
}) {
  const actions = useTreeActions();
  const treeKey = `db:${db}`;
  const { tabIndex, onFocus } = useTabStop(actions.store, treeKey);
  const openMenu = (e: ContextMenuTriggerEvent) => actions.dbMenu(e, db);
  return (
    <TreeRow
      data-tree-key={treeKey}
      pl="1"
      onClick={() => actions.toggleDb(db)}
      onContextMenu={openMenu}
      role="treeitem"
      aria-label={db}
      aria-level={level + 2}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-expanded={open}
      tabIndex={tabIndex}
      onFocus={onFocus}
      onKeyDown={actions.makeKeyDown(() => actions.toggleDb(db), openMenu)}
      {...actions.treeTooltip(`${db} — ${containerLabel}`)}
    >
      <TreeChevron transform={open ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
      <TreeIcon color="app.dbAccent" aria-hidden><Icon name="database" /></TreeIcon>
      <TreeLabel fontWeight={400}><HighlightText text={db} query={q} /></TreeLabel>
      <TreeMoreActions onOpen={openMenu} />
    </TreeRow>
  );
});

/** 見出し行の文言。 */
function useHeaderLabel(): (group: ExplorerHeaderGroup) => string {
  const t = useT();
  return (group) => {
    switch (group) {
      case "favorites": return t("quickAccessFavorites");
      case "recent": return t("quickAccessRecent");
      case "tables": return t("objGroupTables");
      case "views":
      case "view": return t("objGroupViews");
      case "columns": return t("treeColumnsLabel");
      case "indexes": return t("indexesLabel");
      case "foreignKeys": return t("treeForeignKeysLabel");
      case "materialized_view": return t("objGroupMatViews");
      case "procedure": return t("objGroupProcedures");
      case "function": return t("objGroupFunctions");
      case "trigger": return t("objGroupTriggers");
    }
  };
}

interface SchemaRowContentProps {
  row: ExplorerRow;
  /** `groupLevel` (グループ見出しがあるとき 1)。 */
  level: number;
  q: string;
  removableFavorites: boolean;
  containerLabel: string;
}

/** フラットな行 (`ExplorerRow`) を、種別ごとの `memo` 行コンポーネントへ渡す。 */
function SchemaRowContent({ row, level, q, removableFavorites, containerLabel }: SchemaRowContentProps) {
  const t = useT();
  const headerLabel = useHeaderLabel();
  switch (row.kind) {
    case "header":
      return (
        <QuickAccessHeader>
          {headerLabel(row.group)}
          {row.count !== null && (
            <>
              {" "}
              <chakra.span textStyle="numeric">({row.count})</chakra.span>
            </>
          )}
        </QuickAccessHeader>
      );
    case "loading":
      return <LoadingRow />;
    case "empty":
      return (
        <TreeEmpty>
          {row.message === "databases"
            ? t("treeNoDatabases")
            : row.message === "tables"
              ? t("treeNoTables")
              : t("treeNoColumns")}
        </TreeEmpty>
      );
    case "quick":
      return (
        <QuickAccessRow
          refItem={row.ref}
          kind={row.variant}
          level={level}
          removable={removableFavorites}
          posInSet={row.posInSet}
          setSize={row.setSize}
        />
      );
    case "db":
      return (
        <DbRow
          db={row.db}
          open={row.open}
          level={level}
          q={q}
          containerLabel={containerLabel}
          posInSet={row.posInSet}
          setSize={row.setSize}
        />
      );
    case "table":
      return (
        <TableNode
          db={row.db}
          tbl={row.tbl}
          view={row.view}
          q={q}
          level={level}
          open={row.open}
          rowEst={row.rowEst}
          comment={row.comment}
          isActive={row.isActive}
          posInSet={row.posInSet}
          setSize={row.setSize}
        />
      );
    case "column":
      return (
        <ColumnRow
          db={row.db}
          tbl={row.tbl}
          col={row.col}
          level={level}
          q={q}
          posInSet={row.posInSet}
          setSize={row.setSize}
        />
      );
    case "index":
      return (
        <IndexRow
          db={row.db}
          tbl={row.tbl}
          idx={row.idx}
          level={level}
          posInSet={row.posInSet}
          setSize={row.setSize}
        />
      );
    case "foreignKey":
      return (
        <ForeignKeyRow
          db={row.db}
          tbl={row.tbl}
          fk={row.fk}
          level={level}
          posInSet={row.posInSet}
          setSize={row.setSize}
        />
      );
    case "object":
      return (
        <SchemaObjectRow
          db={row.db}
          o={row.o}
          kindLabel={headerLabel(row.o.kind)}
          level={level}
          q={q}
          posInSet={row.posInSet}
          setSize={row.setSize}
        />
      );
  }
}

// --- スキーマツリーの仮想化 (#1315) ---

/** フラットな行数がこれを超えたときだけ仮想化する。jsdom はレイアウトを持たず仮想化すると
 *  0 行になるので、少ないツリー (と既存のユニットテスト) は全行をそのまま描く。 */
const VIRTUALIZE_ROW_THRESHOLD = 200;
/** 窓の上下に余分に描画する行数 (高速スクロール中の空白を減らす)。 */
const VIRTUAL_OVERSCAN = 12;
/** 実測するまでの行高の見積もり (種別ごとに最初の実測値で置き換える)。 */
const ROW_HEIGHT_ESTIMATE = 28;
const HEADER_HEIGHT_ESTIMATE = 22;
const LOADING_HEIGHT_ESTIMATE = 90;
/** 展開操作で増えた行がフェードインする時間 (ms) が過ぎたら、入場クラスを外す目安。 */
const ENTER_CLASS_LIFETIME_MS = 400;

const NO_KEYS: ReadonlySet<string> = new Set();
const EMPTY_REFS: readonly TableRef[] = [];

/** 破線インデントを `depth` 段ぶん重ねる (行ごとに入れ子の `TreeChildren` を再現する)。 */
function Indent({ depth, children }: { depth: number; children: React.ReactNode }) {
  let node = children;
  for (let i = 0; i < depth; i++) node = <TreeChildren>{node}</TreeChildren>;
  return <>{node}</>;
}

/** `ConnectionList` のキーボード操作から見たスキーマ行リストの窓口。 */
interface SchemaRowListHandle {
  /** 行リストのコンテナ要素 (DOM 上の位置の基準)。 */
  element: () => HTMLElement | null;
  /** フォーカスできる行を上から並べた、キーボード巡回用の一覧 (窓の外の行も含む)。 */
  entries: () => (TreeNavEntry & { key: string })[];
  /** 指定キーの行へフォーカスする。窓の外ならスクロールして描画してからフォーカスする。 */
  focusKey: (key: string) => void;
}

interface SchemaRowListProps {
  rows: ExplorerRow[];
  level: number;
  q: string;
  removableFavorites: boolean;
  containerLabel: string;
  scrollRef: React.RefObject<HTMLElement | null>;
  handleRef: { current: SchemaRowListHandle | null };
  store: TabStopStore;
  /** 現在結果パネルに開いているテーブルの行キー。窓の外でも常にマウントしておく。 */
  activeKey: string | null;
  /** このリストより上の要素の高さが変わりうる状態 (開閉・並べ替え)。変わったら位置を測り直す。 */
  layoutToken: string;
}

/**
 * アクティブ接続のスキーマのサブツリー (`ExplorerRow[]`) を描画する。
 *
 * 行数が `VIRTUALIZE_ROW_THRESHOLD` 以下なら全行を、超えたら `@tanstack/react-virtual` で
 * 見えている窓の分だけを描く。スクロール要素 (`treeRef`) はプロファイル / グループの層と共有し、
 * このリストが始まる位置を `scrollMargin` で補正する。位置合わせは `translateY` ではなく
 * 上下 (と、ピン留め行の間) のスペーサーで行う (`layoutId` のインジケータが誤反応しないように)。
 */
const SchemaRowList = memo(function SchemaRowList({
  rows,
  level,
  q,
  removableFavorites,
  containerLabel,
  scrollRef,
  handleRef,
  store,
  activeKey,
  layoutToken,
}: SchemaRowListProps) {
  const virtual = rows.length > VIRTUALIZE_ROW_THRESHOLD;
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // Tab で止まる行 (roving tabindex) も窓の外へ出さない。フォーカス移動のたびに購読して
  // 更新するが、再レンダーされるのはこのリストの枠だけ (行は `memo`)。
  const tabStopKey = useSyncExternalStore(store.subscribe, store.get);

  const keyIndex = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.key, i));
    return m;
  }, [rows]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const keyIndexRef = useRef(keyIndex);
  keyIndexRef.current = keyIndex;
  const levelRef = useRef(level);
  levelRef.current = level;
  const kindHeights = useRef(new Map<string, number>());
  const pendingFocus = useRef<string | null>(null);

  // 行ごとの高さは密度とフォント拡大で変わるので実測する (`measureElement`)。実測前の見積もりは、
  // 同じ種別で最初に測れた高さを使い、スクロールバーの伸び縮みを抑える。
  const estimateSize = (i: number) => {
    const kind = rows[i]?.kind ?? "table";
    const known = kindHeights.current.get(kind);
    if (known !== undefined) return known;
    if (kind === "header") return HEADER_HEIGHT_ESTIMATE;
    if (kind === "loading") return LOADING_HEIGHT_ESTIMATE;
    return ROW_HEIGHT_ESTIMATE;
  };
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: VIRTUAL_OVERSCAN,
    scrollMargin,
    getItemKey: (i) => rows[i]?.key ?? i,
    measureElement: (el, entry) => {
      const box = entry?.borderBoxSize?.[0];
      const h = Math.round(box ? box.blockSize : el.getBoundingClientRect().height);
      const kind = (el as HTMLElement).dataset.kind;
      if (kind && kind !== "loading" && h > 0) kindHeights.current.set(kind, h);
      return h;
    },
    // フォーカス中の行・Tab で止まる行・現在地の行は、窓の外へ出てもアンマウントしない
    // (アンマウントするとフォーカスが `body` へ落ちる)。
    rangeExtractor: (range: Range) => {
      const base = defaultRangeExtractor(range);
      const pinned: number[] = [];
      const pin = (key: string | null | undefined) => {
        if (!key) return;
        const i = keyIndex.get(key);
        if (i !== undefined) pinned.push(i);
      };
      pin(tabStopKey);
      pin(activeKey);
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && listRef.current?.contains(focused)) {
        pin(focused.closest<HTMLElement>("[data-tree-key]")?.dataset.treeKey);
      }
      if (pinned.length === 0) return base;
      return Array.from(new Set([...base, ...pinned])).sort((a, b) => a - b);
    },
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const virtualRef = useRef(virtual);
  virtualRef.current = virtual;

  // リストの先頭がスクロール要素の中のどこから始まるか (`scrollMargin`)。測るのは「位置が
  // 変わりうるきっかけ」のときだけで、描画のたびには測らない (`getBoundingClientRect` は
  // 直前の DOM 変更があると強制リフローになる, #1342)。きっかけは次の 3 つ。
  //  1. 仮想化の ON/OFF・上の層の構造 (`layoutToken`: プロファイル / グループの開閉・増減)
  //     が変わったコミット直後 (1 回だけ測る)。
  //  2. リストより上にある兄弟要素 (祖先を scroller まで辿った各階層の前の兄弟) の大きさの変化。
  //     開閉アニメーション中や、密度・フォント拡大で行の高さが変わる場合を拾う。
  //     `ResizeObserver` のコールバックはレイアウト計算後に呼ばれるので、そこで読んでも
  //     強制リフローにならない。
  //  3. scroller 自体の大きさの変化 (ウィンドウサイズ) と、`<html>` の属性・style の変化
  //     (`data-density` / `--font-scale`。上に兄弟が無くても余白が変わる)。rAF で 1 フレーム 1 回に間引く。
  // 値が変わらなければ state は更新しない。
  // 位置は `getBoundingClientRect` ではなく `layoutTop` (transform を含まない) で測る。上の層の
  // `Reorder.Item` (`layout="position"`) は、兄弟の開閉で位置が変わると translate の FLIP で
  // 元の位置から滑らせる。その間に読む `getBoundingClientRect` は「見た目の位置」で、
  // アニメーション開始直後に測ると transform のぶん (開閉した行の高さ) ずれた値になる。
  // transform の変化では ResizeObserver が発火しないので、ずれた値のまま測り直されず、
  // 窓が数行ずれたまま残っていた (CPU が遅い環境でだけ、測る瞬間が FLIP の開始と重なる)。
  void layoutToken; // 依存として使う (測り直しのきっかけ)
  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutToken は本体で参照しないが、仮想化の ON/OFF・上の層の構造が変わったコミット直後に scrollMargin を測り直すためのトリガーとして意図的に依存へ含めている
  useLayoutEffect(() => {
    if (!virtual) return;
    const list = listRef.current;
    const scroller = scrollRef.current;
    if (!list || !scroller) return;
    const measure = () => {
      // スクロール要素のボーダーボックス上端からの、スクロールしていないときの位置。
      const offset = layoutTop(list) - layoutTop(scroller);
      setScrollMargin((prev) => (prev === offset ? prev : offset));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    for (let node: HTMLElement | null = list; node && node !== scroller; node = node.parentElement) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) ro.observe(sib);
    }
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-density"] });
    return () => {
      ro.disconnect();
      mo?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [virtual, layoutToken, scrollRef]);

  // 窓の外の行へのフォーカス: スクロールして描画させ、描画できたらフォーカスする。
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    const el = findRowElement(listRef.current, key);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    } else if (!keyIndex.has(key)) {
      pendingFocus.current = null;
    }
  });

  useLayoutEffect(() => {
    handleRef.current = {
      element: () => listRef.current,
      entries: () =>
        rowsRef.current.filter(isFocusableExplorerRow).map((r) => ({
          key: r.key,
          level: levelRef.current + 2 + r.depth,
          ...explorerRowExpansion(r),
          label: explorerRowLabel(r),
        })),
      focusKey: (key) => {
        const el = findRowElement(listRef.current, key);
        if (el) {
          el.focus();
          return;
        }
        const i = keyIndexRef.current.get(key);
        if (i === undefined || !virtualRef.current) return;
        pendingFocus.current = key;
        virtualizerRef.current.scrollToIndex(i, { align: "auto" });
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  // 展開操作で増えた行だけ入場アニメを付ける (退場は廃止)。直前の行配列と比べ、
  // 「閉じていた親の直下に新しく現れた行」だけを対象にする — 非同期ロードの完了や検索の
  // 打鍵で増えた行はアニメしない。
  const prevRowsRef = useRef<ExplorerRow[] | null>(null);
  const enterKeys = useRef<ReadonlySet<string>>(NO_KEYS);
  const computedFor = useRef<ExplorerRow[] | null>(null);
  if (computedFor.current !== rows) {
    computedFor.current = rows;
    const prev = prevRowsRef.current;
    if (prev && prev !== rows) {
      const prevKeys = new Set<string>();
      const prevOpen = new Map<string, boolean>();
      for (const r of prev) {
        prevKeys.add(r.key);
        if (r.kind === "db" || r.kind === "table") prevOpen.set(r.key, r.open);
      }
      const added = new Set<string>();
      for (const r of rows) {
        if (!prevKeys.has(r.key) && prevOpen.get(r.parent) === false) added.add(r.key);
      }
      enterKeys.current = added.size > 0 ? added : NO_KEYS;
    } else {
      enterKeys.current = NO_KEYS;
    }
  }
  useEffect(() => {
    prevRowsRef.current = rows;
    if (enterKeys.current === NO_KEYS) return;
    const timer = setTimeout(() => {
      enterKeys.current = NO_KEYS;
    }, ENTER_CLASS_LIFETIME_MS);
    return () => clearTimeout(timer);
  }, [rows]);

  const renderRow = (row: ExplorerRow, index: number, measure?: (el: Element | null) => void) => (
    <div
      key={row.key}
      ref={measure}
      data-index={index}
      data-kind={row.kind}
      className={enterKeys.current.has(row.key) ? "tree-row-enter" : undefined}
    >
      <Indent depth={row.depth}>
        <SchemaRowContent
          row={row}
          level={level}
          q={q}
          removableFavorites={removableFavorites}
          containerLabel={containerLabel}
        />
      </Indent>
    </div>
  );

  let content: React.ReactNode;
  if (!virtual) {
    content = rows.map((row, i) => renderRow(row, i));
  } else {
    const items = virtualizer.getVirtualItems();
    const out: React.ReactNode[] = [];
    // リスト先頭からの相対位置。ピン留め行で窓が途切れる箇所にもスペーサーを挟む。
    let cursor = 0;
    for (const item of items) {
      const row = rows[item.index];
      if (!row) continue;
      const start = item.start - scrollMargin;
      if (start > cursor) out.push(<div key={`sp:${item.key}`} aria-hidden style={{ height: start - cursor }} />);
      out.push(renderRow(row, item.index, virtualizer.measureElement));
      cursor = item.end - scrollMargin;
    }
    const tail = virtualizer.getTotalSize() - cursor;
    if (tail > 0) out.push(<div key="sp:tail" aria-hidden style={{ height: tail }} />);
    content = out;
  }

  // `overflow-anchor: none`: ブラウザのスクロールアンカリングが、窓の移動で変わるスペーサーの
  // 高さに反応してスクロール位置をずらさないようにする。
  return (
    <div ref={listRef} style={{ overflowAnchor: "none" }}>
      {content}
    </div>
  );
});

/**
 * 要素のボーダーボックス上端の、レイアウト上の y 座標 (`offsetParent` を辿った `offsetTop` の和)。
 * `getBoundingClientRect` と違い、要素と祖先の CSS transform (Motion の layout アニメーションの
 * FLIP) を含まず、途中のスクロール要素のスクロール量にも依存しない。同じ文書内の 2 要素の差が、
 * transform が無いときの `getBoundingClientRect().top` の差 (+ 間のスクロール量) と一致する。
 */
function layoutTop(el: HTMLElement): number {
  let y = 0;
  for (let node: HTMLElement | null = el; node; node = node.offsetParent as HTMLElement | null) {
    y += node.offsetTop;
  }
  return y;
}

/** リスト内の `data-tree-key` が一致する行要素。属性セレクタに任意文字列を埋め込まない。 */
function findRowElement(list: HTMLElement | null, key: string): HTMLElement | null {
  if (!list) return null;
  for (const el of list.querySelectorAll<HTMLElement>("[data-tree-key]")) {
    if (el.dataset.treeKey === key) return el;
  }
  return null;
}

// React.memo + forwardRef でラップし、App.tsx の再レンダリング (クエリ入力や
// ストリーミングのたびに発生する) でツリー全体が無駄に再描画されるのを防ぐ。
// forwardRef は App.tsx から focusFilter() を呼ぶための ConnectionListHandle を
// 公開するために必要。親から渡るコールバックは、`tabs` / `activeTab` に依存するものを
// App 側で `useStableCallbacks` (ref 経由の安定ラッパー) に包んでいるため参照が変わらず、
// 接続状態・スキーマなどツリーの表示に関わる props が変わらない限り memo がスキップする
// (#1314)。
export const ConnectionList = memo(forwardRef<ConnectionListHandle, Props>(function ConnectionList({
  profiles,
  activeProfileId,
  activeTable,
  sessionId,
  connectingId,
  errorProfileId,
  openProfileIds,
  onConnect,
  onDisconnectProfile,
  onReorderProfiles,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
  onPickTable,
  onOpenStructure,
  onImportTable,
  onTransferTable,
  onImportNewTable,
  onGenerateTestData,
  onConfigureOpenQuery,
  onDumpDatabase,
  onRunScript,
  onSchemaExport,
  onRunTableSelect,
  onInsertTableSelect,
  onShowCreateTable,
  onCopyTableDdl,
  onCreateTable,
  onTruncateTable,
  onDropTable,
  onRenameTable,
  onAlterTable,
  onCreateIndex,
  onDropIndex,
  onRunTableMaintenance,
  onRunDatabaseMaintenance,
  onSyncIdentity,
  onShowDatabaseSizes,
  onCreateNamespace,
  onDropNamespace,
  onExploreColumns,
  onWatchTable,
  onCreateSandbox,
  sandboxes,
  onOpenSandbox,
  onReviewSandbox,
  onDiscardSandbox,
  onCopyTableName,
  onInsertColumn,
  onCopyColumnName,
  onOpenObjectDefinition,
  onEditViewDefinition,
  onDropView,
  onRunRoutine,
  onEditRoutine,
  onCreateRoutine,
  onFindUsages,
  selectLimit,
  favorites,
  recent,
  onToggleFavorite,
}, ref) {
  const t = useT();
  // アクティブテーブル行のスパインが共有する layoutId (#982)。`TabBar` の
  // `indicatorId` と同じ理由でコンポーネントインスタンスごとにスコープする。
  const activeTableIndicatorId = `tree-active-table-indicator-${useId()}`;
  const [expandedProfiles, setExpandedProfiles] = useState<Record<string, boolean>>({});
  const [expandedDbs, setExpandedDbs] = useState<Record<string, boolean>>({});
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  // グループ折りたたみ状態は localStorage に永続化し、再起動後も維持する。
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(readCollapsedGroups);
  // グループの表示順序 (#786)。触られていない名前は `applyGroupOrder` が
  // アルファベット順で埋める (= 既存の既定挙動) ので、初期値は空でよい。
  const [groupOrder, setGroupOrder] = useState<string[]>(readGroupOrder);
  const [tableColumns, setTableColumns] = useState<Record<string, TableColumnInfo[]>>({});
  // テーブルごとのインデックス一覧。テーブル展開時に列と並行で遅延取得する。
  const [tableIndexes, setTableIndexes] = useState<Record<string, IndexInfo[]>>({});
  // DB ごとの非テーブルオブジェクト。DB 展開時に遅延取得する。
  const [schemaObjects, setSchemaObjects] = useState<Record<string, SchemaObject[]>>({});
  const [databases, setDatabases] = useState<string[] | null>(null);
  const [tables, setTables] = useState<Record<string, string[]>>({});
  // Approximate row counts per database, keyed `db -> table -> estimate`. Read
  // from engine statistics (no COUNT(*) scan); a table with no cheap estimate
  // (views, SQLite, stats not yet gathered) simply has no entry and shows no
  // badge. Loaded alongside the table list when a database is expanded.
  const [rowEstimates, setRowEstimates] = useState<
    Record<string, Record<string, number | null>>
  >({});
  // DB ごとのテーブルコメント (#1002)、`db -> table -> comment`。コメントを持つ
  // テーブルだけが入る。行ツールチップに添える装飾情報なので失敗は無視する。
  const [tableComments, setTableComments] = useState<Record<string, Record<string, string>>>({});
  const [filter, setFilter] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // カラム行の詳細ホバーカード (`ColumnTooltip`)。単純テキストではないので
  // `useDelegatedTooltip` ではなくその一般形 `useDelegatedHover` に載せ、hover
  // 遅延・「同時に見えるのは 1 つ」の登録簿・スクロール連動非表示を他の
  // ツールチップと共有する。
  // スキーマツリー行 (DB/テーブル/インデックス/オブジェクト) の単純テキスト
  // ツールチップは、`ColumnTooltip` と同じ「1 つの共有ツールチップ + イベント委譲」
  // 方式を汎用化した `useDelegatedTooltip` (`Tooltip.tsx`、#884) に委譲する。行数に
  // 比例して Tooltip インスタンスを増やさない — ツリーは数百行規模になりうる。
  // ホバーの state は `ConnectionList` 本体ではなく `*TooltipLayer` が持つ (#1314)。
  // ツールチップの出入りでツリー全体を描き直さないため、行へ渡す `bind` は
  // 安定ラッパー (`useLazyBind`) 越しにする。
  const columnTooltipBindRef = useRef<HoverBind<TableColumnInfo> | null>(null);
  const columnTooltipProps = useLazyBind(columnTooltipBindRef);
  const treeTooltipBindRef = useRef<HoverBind<string> | null>(null);
  const treeTooltipProps = useLazyBind(treeTooltipBindRef);
  // Databases whose table list is currently being fetched, either by manual
  // expand (toggleDb) or by eager schema-search loading. Shared so that rapid
  // collapse / re-expand during an in-flight fetch can't re-issue the same
  // request — and so the schema search and manual paths don't race.
  const tablesInFlightRef = useRef<Set<string>>(new Set());
  // Table keys (db::tbl) whose column list is currently being fetched. Same
  // role as `tablesInFlightRef` but for the column-level expand.
  const columnsInFlightRef = useRef<Set<string>>(new Set());
  // Databases whose row-count estimates are currently being fetched. Mirrors
  // `tablesInFlightRef` so overlapping expands don't re-issue the estimate query.
  const estimatesInFlightRef = useRef<Set<string>>(new Set());

  useImperativeHandle(ref, () => ({
    focusFilter: () => {
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    },
    refreshSchema: () => {
      void refreshSchemaRef.current?.();
    },
  }));
  // `refreshSchema` is defined later in the body; reach it through a ref so the
  // imperative handle doesn't depend on declaration order.
  const refreshSchemaRef = useRef<(() => Promise<void>) | null>(null);

  // Id of the session whose schema is currently being re-fetched, or null.
  // Keyed by session (not a shared boolean) so a refresh only disables/​spins
  // the button on its own connection row, leaving other connections usable.
  const [refreshingSession, setRefreshingSession] = useState<string | null>(null);

  // Latest session id, read after awaits to drop stale schema results when the
  // user switches connections mid-refresh (otherwise the old session's tree
  // could overwrite the new one).
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Tree expansion is persisted per profile (#677). We persist imperatively from
  // the toggle handlers (below) rather than from a reactive effect, so a
  // disconnect that resets the tree to `{}` can't wipe the saved state, and a
  // transient prop mismatch can't save under the wrong profile. These refs let
  // the handlers read the latest profile / other-axis state without re-binding.
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const expandedDbsRef = useRef(expandedDbs);
  expandedDbsRef.current = expandedDbs;
  const expandedTablesRef = useRef(expandedTables);
  expandedTablesRef.current = expandedTables;
  const persistTree = useCallback(
    (dbs: Record<string, boolean>, tables: Record<string, boolean>) => {
      const pid = activeProfileIdRef.current;
      if (pid) saveSchemaTree(pid, { dbs, tables });
    },
    [],
  );

  // Restore the persisted tree expansion for the connecting session's profile
  // (#677) and eagerly re-fetch the open nodes so the tree comes back
  // drilled-in rather than collapsed. DB/table keys that no longer exist are
  // ignored (and pruned from storage). Mirrors `refreshSchema`'s eager reload,
  // but driven off the stored open-set instead of live React state.
  const restoreTreeForSession = useCallback(
    async (targetSessionId: string) => {
      const pid = activeProfileIdRef.current;
      const stored = pid ? loadSchemaTree(pid) : { dbs: {}, tables: {} };
      const openDbNames = Object.keys(stored.dbs).filter((db) => stored.dbs[db]);
      const openTableKeys = Object.keys(stored.tables).filter((k) => stored.tables[k]);
      // Optimistically open the stored nodes so the tree feels continuous while
      // the schema loads; pruned below once we know what still exists.
      setExpandedDbs(openDbNames.length > 0 ? { ...stored.dbs } : {});
      setExpandedTables(openTableKeys.length > 0 ? { ...stored.tables } : {});

      // DB 一覧 + 開いている DB のテーブル/行数推定/非テーブルオブジェクト/コメント +
      // 開いているテーブルの列/インデックスを `load_schema_tree` 1 回で取得する
      // (#1263)。以前は DB ごと・テーブルごとに直列に IPC を呼んでいた。
      let tree: SchemaTree;
      try {
        tree = await api.loadSchemaTree(targetSessionId, openDbNames, openTableKeys);
      } catch (e) {
        if (sessionIdRef.current === targetSessionId) setError(String(e));
        return;
      }
      if (sessionIdRef.current !== targetSessionId) return;
      const dbs = tree.databases;
      setDatabases(dbs);

      const existingOpenDbs = openDbNames.filter((db) => dbs.includes(db));

      const nextTables: Record<string, string[]> = {};
      const nextEstimates: Record<string, Record<string, number | null>> = {};
      const nextObjects: Record<string, SchemaObject[]> = {};
      const nextComments: Record<string, Record<string, string>> = {};
      for (const d of tree.open) {
        // A database whose table list failed is skipped; re-expanding retries it.
        if (d.tables) nextTables[d.database] = d.tables.filter((tbl) => !isSandboxShadowTableName(tbl));
        // Estimates / comments are decorative; a failure just drops the badges.
        if (d.row_estimates) {
          const map: Record<string, number | null> = {};
          for (const e of d.row_estimates) map[e.name] = e.estimate;
          nextEstimates[d.database] = map;
        }
        nextObjects[d.database] = d.objects;
        if (d.comments) nextComments[d.database] = tableCommentMap(d.comments);
      }

      // Columns (+ indexes) only for open tables under an open DB that we listed
      // and confirmed still exist.
      const nextCols: Record<string, TableColumnInfo[]> = {};
      const nextIndexes: Record<string, IndexInfo[]> = {};
      for (const tt of tree.tables) {
        const sep = tt.key.indexOf("::");
        if (sep < 0) continue;
        if (!nextTables[tt.key.slice(0, sep)]?.includes(tt.key.slice(sep + 2))) continue;
        nextCols[tt.key] = tt.columns;
        nextIndexes[tt.key] = tt.indexes;
      }

      setTables((prev) => ({ ...prev, ...nextTables }));
      setRowEstimates((prev) => ({ ...prev, ...nextEstimates }));
      setTableComments((prev) => ({ ...prev, ...nextComments }));
      setSchemaObjects((prev) => ({ ...prev, ...nextObjects }));
      setTableColumns((prev) => ({ ...prev, ...nextCols }));
      setTableIndexes((prev) => ({ ...prev, ...nextIndexes }));

      // Prune only DBs/tables we can CONFIRM are gone. A table key is dropped
      // only when its DB no longer exists, or its DB was listed here and the
      // table is absent. Tables under a collapsed DB (not listed this pass) or a
      // DB whose listTables failed are "unknown" and kept, so a transient error
      // or a closed-but-existing DB never wipes persisted expansion (#677).
      const keptTableKeys = openTableKeys.filter((key) => {
        const sep = key.indexOf("::");
        if (sep < 0) return false; // malformed → drop
        const db = key.slice(0, sep);
        const tbl = key.slice(sep + 2);
        if (!dbs.includes(db)) return false; // DB gone → table gone
        const listed = nextTables[db]; // undefined = collapsed DB or listTables failed
        if (listed && !listed.includes(tbl)) return false; // confirmed absent
        return true; // present or unknown → keep
      });
      // Merge onto the latest live state (via refs) so DBs/tables the user
      // expanded during the async restore aren't clobbered (#677). Only keys we
      // confirmed gone are removed; survivors are ensured open.
      const finalDbs: Record<string, boolean> = {};
      for (const [db, open] of Object.entries(expandedDbsRef.current)) {
        if (open && dbs.includes(db)) finalDbs[db] = true;
      }
      for (const db of existingOpenDbs) finalDbs[db] = true;
      const goneTableKeys = new Set(openTableKeys.filter((k) => !keptTableKeys.includes(k)));
      const finalTables: Record<string, boolean> = {};
      for (const [key, open] of Object.entries(expandedTablesRef.current)) {
        if (open && !goneTableKeys.has(key)) finalTables[key] = true;
      }
      for (const key of keptTableKeys) finalTables[key] = true;
      setExpandedDbs(finalDbs);
      setExpandedTables(finalTables);
      // Persist the pruned baseline only when we actually removed stale keys
      // (user toggles during restore already persisted themselves).
      if (
        existingOpenDbs.length !== openDbNames.length ||
        keptTableKeys.length !== openTableKeys.length
      ) {
        persistTree(finalDbs, finalTables);
      }
    },
    [persistTree],
  );

  // Re-query the schema for the active session without disconnecting, so
  // server-side changes (new/dropped tables or columns) show up. Currently
  // expanded databases/tables are re-fetched in place to preserve the tree's
  // open state; collapsed nodes reload lazily on next expand as usual.
  const refreshSchema = useCallback(async () => {
    if (!sessionId || refreshingSession === sessionId) return;
    const targetSessionId = sessionId;
    setRefreshingSession(targetSessionId);
    setError(null);
    try {
      // 明示的な Refresh (#1097): バックエンドの Schema Cache を無効化してから
      // 再取得する。無効化に失敗しても (セッション消失など) 通常のフローで
      // エラーになるだけなので、以降の再取得自体は続行する。
      try {
        await api.refreshSchemaCache(targetSessionId);
      } catch {
        // ignore — 下の listDatabases がセッション消失を検知してエラー表示する。
      }
      // 一覧・開いている DB/テーブルの内容を `load_schema_tree` 1 回で再取得する (#1263)。
      const tree = await api.loadSchemaTree(
        targetSessionId,
        Object.keys(expandedDbs).filter((db) => expandedDbs[db]),
        Object.keys(expandedTables).filter((key) => expandedTables[key]),
      );
      const dbs = tree.databases;
      const nextTables: Record<string, string[]> = {};
      const nextEstimates: Record<string, Record<string, number | null>> = {};
      const nextObjects: Record<string, SchemaObject[]> = {};
      const nextComments: Record<string, Record<string, string>> = {};
      for (const d of tree.open) {
        // Skip a database that failed to list; re-expanding retries it.
        if (d.tables) nextTables[d.database] = d.tables.filter((tbl) => !isSandboxShadowTableName(tbl));
        // Estimates / comments are decorative; a failure just drops the badges.
        if (d.row_estimates) {
          const map: Record<string, number | null> = {};
          for (const e of d.row_estimates) map[e.name] = e.estimate;
          nextEstimates[d.database] = map;
        }
        nextObjects[d.database] = d.objects;
        if (d.comments) nextComments[d.database] = tableCommentMap(d.comments);
      }
      const nextCols: Record<string, TableColumnInfo[]> = {};
      const nextIndexes: Record<string, IndexInfo[]> = {};
      for (const tt of tree.tables) {
        const sep = tt.key.indexOf("::");
        if (sep < 0) continue;
        if (!nextTables[tt.key.slice(0, sep)]?.includes(tt.key.slice(sep + 2))) continue;
        nextCols[tt.key] = tt.columns;
        nextIndexes[tt.key] = tt.indexes;
      }
      // The session may have changed while we awaited — don't clobber the new
      // connection's tree with results fetched for the old one.
      if (sessionIdRef.current !== targetSessionId) return;
      tablesInFlightRef.current.clear();
      setDatabases(dbs);
      setTables(nextTables);
      setRowEstimates(nextEstimates);
      setTableComments(nextComments);
      setSchemaObjects(nextObjects);
      setTableColumns(nextCols);
      setTableIndexes(nextIndexes);
    } catch (e) {
      // Suppress a stale session's error so it can't surface on the new one.
      if (sessionIdRef.current === targetSessionId) setError(String(e));
    } finally {
      // Clear only if it's still this session being tracked, so a connection
      // switch mid-refresh can't wipe a newer session's in-flight flag.
      setRefreshingSession((cur) => (cur === targetSessionId ? null : cur));
    }
  }, [sessionId, refreshingSession, expandedDbs, expandedTables]);
  // Keep the imperative-handle ref pointed at the latest refreshSchema.
  refreshSchemaRef.current = refreshSchema;

  useEffect(() => {
    setTables({});
    setRowEstimates({});
    setTableComments({});
    setTableColumns({});
    setTableIndexes({});
    setSchemaObjects({});
    tablesInFlightRef.current.clear();
    estimatesInFlightRef.current.clear();
    if (sessionId) {
      // Expanded state is restored (not reset) so the tree comes back drilled-in
      // for the reconnecting profile (#677).
      setDatabases(null);
      void restoreTreeForSession(sessionId);
    } else {
      setExpandedDbs({});
      setExpandedTables({});
      setDatabases(null);
    }
  }, [sessionId, restoreTreeForSession]);

  // Auto-expand the active connection.
  useEffect(() => {
    if (activeProfileId) {
      setExpandedProfiles((prev) => ({ ...prev, [activeProfileId]: true }));
    }
  }, [activeProfileId]);

  // 閉じているグループだけを localStorage に保存する。展開が既定なので
  // false のキーのみを書き出し、ストレージを最小限に保つ。
  useEffect(() => {
    const collapsed = Object.entries(expandedGroups)
      .filter(([, open]) => open === false)
      .map(([key]) => key);
    try {
      if (collapsed.length > 0) {
        localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(collapsed));
      } else {
        localStorage.removeItem(COLLAPSED_GROUPS_KEY);
      }
    } catch {
      // ストレージ不可環境では永続化を諦める (セッション内の動作には影響しない)。
    }
  }, [expandedGroups]);

  // グループの表示順序 (#786) を localStorage へ永続化する。ドラッグ/キーボードで
  // 実際に動かした結果のみが `groupOrder` に入るので、何も触っていない初期状態
  // (空配列) では書き込まず、既存のキーもそのままにする (アルファベット順の既定
  // 挙動を壊さない)。
  useEffect(() => {
    try {
      if (groupOrder.length > 0) {
        localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(groupOrder));
      } else {
        localStorage.removeItem(GROUP_ORDER_KEY);
      }
    } catch {
      // ストレージ不可環境では永続化を諦める (セッション内の動作には影響しない)。
    }
  }, [groupOrder]);

  // --- ツリー全体の roving tabindex (#1184) ---
  //
  // DB/テーブル/カラム/インデックス/外部キー/スキーマオブジェクトの各行を含む
  // ツリー全体で「今 Tab で止まる 1 行」を `tabStopStore` として管理する
  // (JsonTreeView の `selectedKey` と同じ考え方だが、こちらは選択状態ではなく
  // 純粋にフォーカスの置き場所だけを表す)。各行は `data-tree-key` に自分の一意な
  // キーを持ち、そのキーが ストアの値と一致するときだけ `tabIndex=0` になる。
  //
  // 初期値・および対象行が消えた場合 (折りたたみ/削除/検索フィルタで非表示) の
  // フォールバックは、ツリー内の最初の `[role=treeitem]` を採用する。
  //
  // 止まり先のキーは React state ではなく外部ストア (`TabStopStore`) に置き、各行が
  // 自分のキーと一致するかだけを購読する (#1314)。フォーカスが動くたびに
  // `ConnectionList` 本体と全行を描き直さず、値が変わる 2 行だけが再レンダーされる。
  // 以前は依存配列の無い `useLayoutEffect` が毎レンダーで全 `[data-tree-key]` を
  // 走査していたが、いまはマウント中のキーをストアが覚えているので O(1) で判定でき、
  // 止まり先が消えたとき (ストアが空になったとき) だけ DOM を読む。
  const treeRef = useRef<HTMLDivElement>(null);
  const [tabStopStore] = useState(createTabStopStore);
  const ensureTabStop = useCallback(() => {
    const container = treeRef.current;
    if (!container) return;
    const current = tabStopStore.get();
    if (current !== null && tabStopStore.has(current)) return;
    // `querySelector` の属性セレクタに任意文字列 (テーブル名など) をそのまま
    // 埋め込むと `"` を含む名前で壊れるため、`dataset` を JS 側で読む。
    const first = container.querySelector<HTMLElement>("[data-tree-key]");
    tabStopStore.set(first?.dataset.treeKey ?? null);
  }, [tabStopStore]);
  // 行が消えて止まり先が空になった / 空のストアへ最初の行が登録されたときに再選出する。
  // 行のアンマウントは DOM 更新の途中で通知されるので、コミット後 (マイクロタスク) に読む。
  useEffect(
    () =>
      tabStopStore.subscribe(() => {
        if (tabStopStore.get() === null) queueMicrotask(ensureTabStop);
      }),
    [tabStopStore, ensureTabStop],
  );

  // スキーマ行リスト (仮想化されていて窓の外の行は DOM に無い) の窓口。キーボード巡回は
  // DOM の `[role=treeitem]` ではなく、ツリー全体を並べた配列で次の行を決める (#1315)。
  const schemaListRef = useRef<SchemaRowListHandle | null>(null);

  /** ツリー全体 (プロファイル / グループ見出し + スキーマ行リスト) を上から並べた巡回用の配列。
   *  スキーマ行は窓の外の行も含め、DOM 上でリストが占める位置へ差し込む。 */
  const buildNavSequence = () => {
    const container = treeRef.current;
    if (!container) return null;
    type Entry = TreeNavEntry & { el?: HTMLElement; key?: string };
    const list = schemaListRef.current;
    const listEl = list?.element() ?? null;
    const entries: Entry[] = [];
    const pushList = () => {
      if (list) for (const e of list.entries()) entries.push(e);
    };
    let listPushed = false;
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("[role=treeitem]"))) {
      if (listEl?.contains(el)) continue;
      if (listEl && !listPushed && listEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        pushList();
        listPushed = true;
      }
      entries.push({
        el,
        level: Number(el.getAttribute("aria-level") ?? "1"),
        expandable: el.hasAttribute("aria-expanded"),
        open: el.getAttribute("aria-expanded") === "true",
        // 先頭の開閉マーク「▸」は表示名ではない。
        label: (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/^\s*▸/, ""),
      });
    }
    if (listEl && !listPushed) pushList();
    return entries;
  };

  /**
   * ツリー行 (プロファイル/グループ見出しを含む全階層) で共有する keydown ハンドラの
   * ファクトリ。フォーカス管理の「1 か所」をここに集約しておくことで、#1185
   * (Shift+F10 / ContextMenu キーでメニューを開く) は分岐を 1 つ足すだけで済む。
   *
   * - Enter/Space: `activate` (行の既定動作。無ければ何もしない)
   * - Shift+F10 / `ContextMenu` キー: `openContextMenu` (行の右クリックメニューと
   *   同じ関数。無ければ何もしない、#1185)。座標は行自身の矩形の左下から算出し、
   *   右クリックの `onContextMenu` へそのまま渡せる `ContextMenuTriggerEvent` を
   *   組み立てる — メニューの組み立てロジック自体は右クリックと共有する。
   * - ArrowLeft/ArrowRight: 展開可能ノードの開閉、または親/子行へのフォーカス移動
   *   (`treeKeyboardNav.ts` の判定を、ツリー全体を並べた配列から組み立てる)
   * - ↑↓/Home/End/先頭文字ジャンプ: 同じ配列に対して `resolveTreeMove` で次の行を決める。
   *   窓の外の行はスクロールして描画させてからフォーカスする (#1315)
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: buildNavSequence は毎レンダーで作り直されるが ref だけを読むため、依存に入れずハンドラの参照を固定する (下の依存配列のコメント参照)
  const makeTreeItemKeyDown = useCallback(
    (activate?: () => void, openContextMenu?: (e: ContextMenuTriggerEvent) => void) =>
      (e: React.KeyboardEvent<HTMLElement>) => {
      // 行の中の操作要素 (テーブル行のチェブロン button など) から伝わってきたキーは
      // その要素自身に任せる。ここで Enter を横取りすると、チェブロンの Enter で
      // カラム一覧を開く代わりにテーブルが開いてしまう (`useTabStop` の `onFocus` と同じ判定)。
      if (e.target !== e.currentTarget) return;
      if (activate && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        activate();
        return;
      }
      if (openContextMenu && isContextMenuOpenKey(pickContextMenuOpenKeys(e))) {
        e.preventDefault();
        openContextMenu(contextMenuTriggerFromRect(e.currentTarget.getBoundingClientRect()));
        return;
      }
      const isArrowLR = e.key === "ArrowLeft" || e.key === "ArrowRight";
      const isMove = e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End";
      // 印字可能な単一文字のみ対象。修飾キー (Ctrl/Alt/Meta) 付きはショートカット用途と
      // 衝突しうるため除外する (Shift は大文字入力に必要なので許可)。
      const isTypeahead = !isArrowLR && !isMove && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
      if (!isArrowLR && !isMove && !isTypeahead) return;

      const row = e.currentTarget;
      const entries = buildNavSequence();
      if (!entries) return;
      const rowKey = row.dataset.treeKey;
      const index = entries.findIndex((en) => (en.el ? en.el === row : en.key === rowKey));
      if (index === -1) return;
      const focusEntry = (en: (typeof entries)[number]) => {
        if (en.el) en.el.focus();
        else if (en.key) schemaListRef.current?.focusKey(en.key);
      };

      if (isArrowLR) {
        const result =
          e.key === "ArrowRight" ? resolveTreeArrowRight(entries, index) : resolveTreeArrowLeft(entries, index);
        if (!result) return;
        e.preventDefault();
        e.stopPropagation();
        if (result.type === "toggle") {
          // チェブロンが別のネイティブ button に分かれている行 (テーブル) は
          // それを、そうでない行 (DB/グループ/プロファイル) は行自身をクリックする
          // — どちらも既存の onClick トグルロジックをそのまま再利用できる。
          const toggleTarget =
            row.querySelector<HTMLElement>("[aria-expanded]") ??
            (row.hasAttribute("aria-expanded") ? row : null);
          toggleTarget?.click();
          // ネイティブ button (テーブル行のチェブロン) をクリックすると、ブラウザが
          // そのボタン自身へフォーカスを移してしまう。矢印キーによる開閉ではフォーカスを
          // 行から動かさない (APG Tree パターン) ため、行へ戻す。
          if (toggleTarget !== row) row.focus();
        } else {
          focusEntry(entries[result.index]);
        }
        return;
      }

      const target = resolveTreeMove(entries, index, e.key);
      // 矢印 / Home / End は端でもブラウザ既定のスクロールを止める。先頭文字ジャンプは
      // 一致が無いときに既定の挙動を妨げない。
      if (isMove || target !== null) e.preventDefault();
      if (target !== null) focusEntry(entries[target]);
    },
    // `buildNavSequence` は ref だけを読むので、依存は無し (ハンドラの参照を固定する)。
    [],
  );
  // --- 接続 / グループの並べ替え (#786) ---
  //
  // Drop-position indicator: the key of the row currently shown as the drag/
  // keyboard-move target. Shared between profile rows and group headers with a
  // `"group:"` prefix on the latter (profile ids never start with it, so the
  // two id spaces can't collide) — mirrors `TabBar`'s single `dropIndicator`
  // state + flash-then-clear helper.
  const [dropIndicator, setDropIndicatorState] = useState<string | null>(null);
  const dropFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDropFlash = useCallback(() => {
    if (dropFlashTimer.current) {
      clearTimeout(dropFlashTimer.current);
      dropFlashTimer.current = null;
    }
  }, []);
  const setDropIndicator = useCallback(
    (key: string | null, flash = true) => {
      clearDropFlash();
      setDropIndicatorState(key);
      if (key && flash) {
        dropFlashTimer.current = setTimeout(() => setDropIndicatorState(null), 700);
      }
    },
    [clearDropFlash],
  );
  useEffect(() => clearDropFlash, [clearDropFlash]);

  // Roving refs so a keyboard move can restore focus to the row it just moved
  // (the DOM node is recreated at a new position on the next render).
  const profileRowRefs = useRef<Map<string, HTMLElement | null>>(new Map());
  const groupRowRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  /** Drag reorder within one flat list of profiles (ungrouped list, or one
   *  group's members). `siblingIds` is the id order that list was rendered
   *  with; `proposed` is Motion's `Reorder.Group.onReorder` payload for that
   *  same list. Guards against a corrupted permutation before embedding the
   *  new relative order back into the full `profiles` order. */
  const handleProfilesDrag = (siblingIds: string[], proposed: string[]) => {
    if (!onReorderProfiles) return;
    const validated = reorderIfPermutation(siblingIds, proposed);
    if (!validated) return;
    const currentIds = profiles.map((p) => p.id);
    const full = applySubsequenceOrder(currentIds, validated);
    if (full !== currentIds) onReorderProfiles(full);
  };

  /** Cmd/Ctrl+Shift+↑/↓ moves the focused profile row within its own list
   *  (ungrouped list, or its group) by one position — mirrors `TabBar`'s
   *  accessible reorder shortcut, adapted to a vertical tree. Enter/Space keep
   *  their existing "activate the row" behavior. */
  const handleProfileRowKeyDown = (p: ConnectionProfile, siblingIds: string[]) => (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleProfileClick(p);
      return;
    }
    // ドラッグと同じく検索フィルタ中は無効 (`reorderEnabled`) — 部分表示のまま
    // 裏の全体順序を動かさない。イベント発火時に評価されるので後方の宣言でよい。
    if (
      reorderEnabled &&
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey
    ) {
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const moved = moveItemBy(siblingIds, p.id, dir);
      if (moved === siblingIds) return;
      e.preventDefault();
      const full = applySubsequenceOrder(
        profiles.map((pp) => pp.id),
        moved,
      );
      onReorderProfiles(full);
      setDropIndicator(p.id);
      requestAnimationFrame(() => profileRowRefs.current.get(p.id)?.focus());
      return;
    }
    // 上記の並べ替えショートカット (修飾キー付き) 以外の矢印キー/Home/End/先頭文字、
    // および Shift+F10 / ContextMenu キー (#1185) はツリー共通のナビゲーションへ
    // 委譲する (#1184)。
    makeTreeItemKeyDown(undefined, (ev) => handleProfileContextMenu(ev, p))(e);
  };

  /** Drag reorder of the named-group headers themselves (relative to one
   *  another; the ungrouped section always stays last, matching the existing
   *  default). Persisted to localStorage, not the backend (groups have no
   *  entity of their own — see `connectionOrder.ts`). */
  const handleGroupsDrag = (namedGroupKeys: string[], proposed: string[]) => {
    const validated = reorderIfPermutation(namedGroupKeys, proposed);
    if (validated) setGroupOrder(validated);
  };

  /** Cmd/Ctrl+Shift+↑/↓ moves the focused group header among its sibling
   *  named groups. Enter/Space keep the existing expand/collapse toggle. */
  const handleGroupRowKeyDown = (name: string, namedGroupKeys: string[]) => (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setExpandedGroups((prev) => ({ ...prev, [name]: prev[name] === false ? true : false }));
      return;
    }
    // 検索フィルタ中は `namedGroupKeys` がヒットしたグループだけの部分集合になる。
    // その部分集合で `setGroupOrder` すると永続化済みの全体順序を可視分だけで
    // 上書きしてしまうため、ドラッグと同じく `reorderEnabled` でガードする。
    if (
      reorderEnabled &&
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey
    ) {
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const moved = moveItemBy(namedGroupKeys, name, dir);
      if (moved === namedGroupKeys) return;
      e.preventDefault();
      setGroupOrder(moved);
      setDropIndicator(`group:${name}`);
      requestAnimationFrame(() => groupRowRefs.current.get(name)?.focus());
      return;
    }
    // 上記の並べ替えショートカット (修飾キー付き) 以外の矢印キー/Home/End/先頭文字は
    // ツリー共通のナビゲーションへ委譲する (#1184)。
    makeTreeItemKeyDown()(e);
  };

  const handleProfileClick = (p: ConnectionProfile) => {
    if (p.id === activeProfileId) {
      setExpandedProfiles((prev) => ({ ...prev, [p.id]: !prev[p.id] }));
      return;
    }
    if (connectingId) return;
    onConnect(p);
  };

  const handleProfileContextMenu = (e: ContextMenuTriggerEvent, p: ConnectionProfile) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(onDisconnectProfile && openProfileIds?.has(p.id)
          ? [
              {
                label: t("contextMenuDisconnect"),
                onSelect: () => onDisconnectProfile(p.id),
              },
            ]
          : []),
        ...(onCreateNamespace && p.id === activeProfileId && treeNamespaceKind(p.driver) !== null
          ? [
              {
                label: t(p.driver === "postgres" ? "contextMenuCreateNamespace" : "contextMenuCreateDatabase"),
                onSelect: () => onCreateNamespace(),
                disabled: p.read_only,
                title: p.read_only ? t("listReadOnlyTitle") : undefined,
              },
            ]
          : []),
        { label: t("contextMenuEdit"), onSelect: () => onEdit(p) },
        { label: t("contextMenuDuplicate"), onSelect: () => onDuplicate(p) },
        {
          label: t("contextMenuDelete"),
          danger: true,
          onSelect: () => {
            if (confirm(t("listDeleteConfirm", { name: p.name }))) onDelete(p);
          },
        },
      ],
    });
  };

  const handleTableContextMenu = (e: ContextMenuTriggerEvent, db: string, tbl: string) => {
    e.preventDefault();
    e.stopPropagation();
    // 先頭はテーブル選択後の 2 つの行き先 (#1112): データ (ダブルクリックと同じ) と
    // 構造 (ボトムパネル)。
    const items: ContextMenuEntry[] = [
      { label: t("contextMenuOpenData"), onSelect: () => onPickTable(db, tbl) },
    ];
    if (onOpenStructure) {
      items.push({ label: t("contextMenuOpenStructure"), onSelect: () => onOpenStructure(db, tbl) });
    }
    items.push(
      { separator: true },
      { label: t("contextMenuRunSelect", { limit: selectLimit }), onSelect: () => onRunTableSelect(db, tbl) },
      { label: t("contextMenuInsertSelect"), onSelect: () => onInsertTableSelect(db, tbl) },
    );
    // デフォルトクエリ (#1253) は設定の保存だけなので read_only でも有効。
    if (onConfigureOpenQuery) {
      items.push({
        label: t("contextMenuConfigureOpenQuery"),
        onSelect: () => onConfigureOpenQuery(db, tbl),
      });
    }
    // DDL の表示 / コピー (#1001)。PostgreSQL はカタログからの再構成なので、
    // ベストエフォートである旨をツールチップで明示する。
    const ddlTitle = isSynthesizedTableDdl(activeDriver) ? t("tableDdlSynthesizedHint") : undefined;
    if (onShowCreateTable) {
      items.push({
        label: t("contextMenuShowCreate"),
        onSelect: () => onShowCreateTable(db, tbl),
        title: ddlTitle,
      });
    }
    if (onCopyTableDdl) {
      items.push({
        label: t("contextMenuCopyDdl"),
        onSelect: () => onCopyTableDdl(db, tbl),
        title: ddlTitle,
      });
    }
    // 列データプロファイル (#974)。読み取りの集計だけなので read_only でも有効。
    if (onExploreColumns) {
      items.push({ label: t("profileMenuLabel"), onSelect: () => onExploreColumns(db, tbl) });
    }
    // テーブル・タイムラプス (#739)。登録時に制約とプライバシーを確認ダイアログで示す。
    if (onWatchTable) {
      items.push({ label: t("timelapseMenuLabel"), onSelect: () => onWatchTable(db, tbl) });
    }
    if (onFindUsages) {
      items.push({ label: t("contextMenuFindUsages"), onSelect: () => onFindUsages(db, tbl, null) });
    }
    if (onToggleFavorite) {
      const fav = (favorites ?? []).some((f) => tableRefEquals(f, { database: db, table: tbl }));
      items.push({ separator: true });
      items.push({
        label: fav ? t("contextMenuRemoveFavorite") : t("contextMenuAddFavorite"),
        onSelect: () => onToggleFavorite(db, tbl),
      });
    }
    items.push({ separator: true });
    // Import writes to the table, so it's rejected on a read-only session;
    // disable it up front rather than letting the backend fail later.
    items.push({
      label: t("contextMenuImportCsv"),
      onSelect: () => onImportTable(db, tbl),
      disabled: activeReadOnly,
      title: activeReadOnly ? t("listReadOnlyTitle") : undefined,
    });
    if (onTransferTable) {
      items.push({
        label: t("contextMenuTransferTable"),
        onSelect: () => onTransferTable(db, tbl),
      });
    }
    // テストデータ生成 (#602) も書き込みなので read_only では無効化する
    // (バックエンドの run_query_transaction も read_only を拒否する)。
    if (onGenerateTestData) {
      items.push({
        label: t("contextMenuGenerateTestData"),
        onSelect: () => onGenerateTestData(db, tbl),
        disabled: activeReadOnly,
        title: activeReadOnly ? t("listReadOnlyTitle") : undefined,
      });
    }
    if (onCopyTableName) {
      items.push({ label: t("contextMenuCopyTableName"), onSelect: () => onCopyTableName(tbl) });
    }
    // テーブル保守操作: TRUNCATE / DROP / RENAME / 列編集 (#794) / インデックス作成
    // (#850)。破壊的なので read_only では無効化し、実行時は呼び出し側 (App) が
    // 確認ダイアログを挟む。
    if (onTruncateTable || onDropTable || onRenameTable || onAlterTable || onCreateIndex) {
      const roTitle = activeReadOnly ? t("listReadOnlyTitle") : undefined;
      items.push({ separator: true });
      if (onRenameTable) {
        items.push({
          label: t("contextMenuRenameTable"),
          onSelect: () => onRenameTable(db, tbl),
          disabled: activeReadOnly,
          title: roTitle,
        });
      }
      if (onAlterTable) {
        items.push({
          label: t("contextMenuAlterTable"),
          onSelect: () => onAlterTable(db, tbl),
          disabled: activeReadOnly,
          title: roTitle,
        });
      }
      if (onCreateIndex) {
        items.push({
          label: t("contextMenuCreateIndex"),
          onSelect: () => onCreateIndex(db, tbl),
          disabled: activeReadOnly,
          title: roTitle,
        });
      }
      if (onTruncateTable) {
        items.push({
          label: t("contextMenuTruncateTable"),
          onSelect: () => onTruncateTable(db, tbl),
          disabled: activeReadOnly,
          title: roTitle,
          danger: true,
        });
      }
      if (onDropTable) {
        items.push({
          label: t("contextMenuDropTable"),
          onSelect: () => onDropTable(db, tbl),
          disabled: activeReadOnly,
          title: roTitle,
          danger: true,
        });
      }
    }
    // テーブル保守コマンド (ANALYZE / OPTIMIZE / VACUUM / REINDEX 等)。#561。
    // ドライバ別に利用可能なものだけを提示する。データは消さないが書き込み/ロックを
    // 伴うため read_only では無効化し、実行時は App が確認ダイアログを挟む。
    if (onRunTableMaintenance) {
      const commands = tableMaintenanceCommands(activeDriver, db, tbl);
      if (commands.length > 0) {
        const roTitle = activeReadOnly ? t("listReadOnlyTitle") : undefined;
        items.push({ separator: true });
        // 保守コマンドはドライバによって 1〜4 件に増減し、それ自体は日常操作では
        // ないので 2 件以上ならサブメニューへ畳む (#1018)。
        items.push(
          ...submenuOrFlat(
            t("contextMenuMaintenanceGroup"),
            commands.map((command) => ({
              label: t(MAINTENANCE_LABEL_KEYS[command.kind]),
              onSelect: () => onRunTableMaintenance(db, tbl, command),
              disabled: activeReadOnly,
              title: roTitle,
            })),
            { icon: "tools" },
          ),
        );
      }
    }
    // 採番列の同期 (#1240)。列メタが読み込み済みで対象列が無いテーブルには出さない
    // (未読み込みなら判定できないので出し、App 側が実行時に再判定する)。
    if (onSyncIdentity) {
      const cols = tableColumns[`${db}::${tbl}`];
      if (!cols || findIdentityColumn(activeDriver, cols) !== null) {
        items.push({
          label: t("contextMenuSyncIdentity"),
          onSelect: () => onSyncIdentity(db, tbl),
          disabled: activeReadOnly,
          title: activeReadOnly ? t("listReadOnlyTitle") : undefined,
        });
      }
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ルーチン (プロシージャ / 関数) の右クリック: パラメータ入力付き実行 (#1003)。
  // read_only でも無効化しない — 読み取りだけの関数もあり、書き込み系は実行時に
  // バックエンドの `ensure_allowed_for_session` が拒否する (二重に判定しない)。
  const handleRoutineContextMenu = (e: ContextMenuTriggerEvent, db: string, o: SchemaObject) => {
    if (!isEditableObjectKind(o.kind)) return;
    const kind = o.kind;
    const canRun = !!onRunRoutine && isRoutineKind(kind);
    if (!canRun && !onEditRoutine) return;
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuEntry[] = [];
    if (canRun && isRoutineKind(kind)) {
      const supported = supportsRoutineExecution(activeDriver);
      items.push({
        label: t("contextMenuRunRoutine"),
        onSelect: () => onRunRoutine?.(db, kind, o.name, o.id),
        disabled: !supported,
        title: supported ? undefined : t("runRoutineUnsupportedDriver"),
      });
    }
    if (onEditRoutine) {
      // 定義の編集 (#1192) はモーダルが開くだけなので閲覧はできる。適用の可否は
      // モーダル側 (read_only はバックエンド強制) が決める。
      const supported = supportsRoutineEditing(activeDriver, kind);
      items.push({
        label: t("contextMenuEditRoutine"),
        onSelect: () => onEditRoutine(db, kind, o.name, o.id),
        disabled: !supported,
        title: supported ? undefined : t("runRoutineUnsupportedDriver"),
      });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ビューの右クリックメニュー: データ / 構造 (#1112)・定義の表示 / 編集 (#851)・
  // 影響分析 (#1027)・DROP VIEW。ルーチン/トリガーの定義編集は
  // `handleRoutineContextMenu` (#1192)。`asNode` が false のときは定義だけを開く旧来のビュー行
  // (`list_tables` と名前が突き合わなかったもの) で、データ系の項目を出さない。
  // テーブル向けの書き込み系 (インポート / TRUNCATE / 列編集など) はビューには出さない。
  const handleViewContextMenu = (
    e: ContextMenuTriggerEvent,
    db: string,
    view: ExplorerViewNode,
    asNode = true,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const { name } = view;
    const items: ContextMenuEntry[] = [];
    if (asNode) {
      items.push({ label: t("contextMenuOpenData"), onSelect: () => onPickTable(db, name) });
      if (onOpenStructure) {
        items.push({ label: t("contextMenuOpenStructure"), onSelect: () => onOpenStructure(db, name) });
      }
      items.push(
        { label: t("contextMenuRunSelect", { limit: selectLimit }), onSelect: () => onRunTableSelect(db, name) },
        { label: t("contextMenuInsertSelect"), onSelect: () => onInsertTableSelect(db, name) },
      );
    }
    if (onOpenObjectDefinition && asNode) {
      items.push({
        label: t("contextMenuShowDefinition"),
        onSelect: () => onOpenObjectDefinition(db, view.kind, name, view.id),
      });
    }
    if (onEditViewDefinition && view.kind === "view") {
      items.push({
        label: t("contextMenuEditViewDefinition"),
        onSelect: () => onEditViewDefinition(db, name),
      });
    }
    // ビューも他のビュー / ルーチンから参照されうるので影響分析の対象にする (#1027)。
    if (onFindUsages) {
      items.push({
        label: t("contextMenuFindUsages"),
        onSelect: () => onFindUsages(db, name, null),
      });
    }
    if (asNode && onToggleFavorite) {
      const fav = (favorites ?? []).some((f) => tableRefEquals(f, { database: db, table: name }));
      items.push({ separator: true });
      items.push({
        label: fav ? t("contextMenuRemoveFavorite") : t("contextMenuAddFavorite"),
        onSelect: () => onToggleFavorite(db, name),
      });
    }
    if (asNode && onCopyTableName) {
      items.push({ label: t("contextMenuCopyTableName"), onSelect: () => onCopyTableName(name) });
    }
    // マテリアライズドビューの REFRESH (#1241)。PostgreSQL 専用。書き込みを伴うので
    // read_only では無効化し、実行時は App が確認ダイアログを挟む。
    if (asNode && onRunTableMaintenance && view.kind === "materialized_view") {
      const refreshCommands = matviewRefreshCommands(activeDriver, db, name);
      if (refreshCommands.length > 0) {
        items.push({ separator: true });
        for (const command of refreshCommands) {
          const concurrently = command.kind === "refreshMatviewConcurrently";
          items.push({
            label: t(MAINTENANCE_LABEL_KEYS[command.kind]),
            onSelect: () => onRunTableMaintenance(db, name, command),
            disabled: activeReadOnly,
            title: activeReadOnly
              ? t("listReadOnlyTitle")
              : concurrently
                ? t("maintenanceRefreshMatviewConcurrentlyHint")
                : undefined,
          });
        }
      }
    }
    if (onDropView && view.kind === "view") {
      if (items.length > 0) items.push({ separator: true });
      items.push({
        label: t("contextMenuDropView"),
        onSelect: () => onDropView(db, name),
        disabled: activeReadOnly,
        title: activeReadOnly ? t("listReadOnlyTitle") : undefined,
        danger: true,
      });
    }
    if (items.length === 0) return;
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // 列ノードの右クリック: エディタへ挿入・列名コピー (#1352) と影響分析 (#1027)。
  // 影響分析は列を RENAME / DROP する前に、その列を参照しているビュー・ルーチン・
  // トリガー・スニペットを探す。
  const handleColumnContextMenu = (e: ContextMenuTriggerEvent, db: string, tbl: string, column: string) => {
    const items: ContextMenuEntry[] = [];
    if (onInsertColumn) {
      items.push(
        { label: t("contextMenuInsertColumnName"), onSelect: () => onInsertColumn(db, tbl, column, false) },
        { label: t("contextMenuInsertQualifiedColumn"), onSelect: () => onInsertColumn(db, tbl, column, true) },
      );
    }
    if (onCopyColumnName) {
      items.push({ label: t("contextMenuCopyColumnName"), onSelect: () => onCopyColumnName(column) });
    }
    if (onFindUsages) {
      if (items.length > 0) items.push({ separator: true });
      items.push({ label: t("contextMenuFindColumnUsages"), onSelect: () => onFindUsages(db, tbl, column) });
    }
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // インデックスノードの右クリック: DROP INDEX (#850)。PK インデックスは
  // `DROP INDEX` 単体では方言によって落とせない (MySQL は `ALTER TABLE ... DROP
  // PRIMARY KEY`、PostgreSQL は制約の DROP が必要) ため、ここでは常に無効化して
  // 誤操作を防ぐ (項目自体は出し、理由をツールチップで明示する)。
  const handleIndexContextMenu = (e: ContextMenuTriggerEvent, db: string, tbl: string, idx: IndexInfo) => {
    e.preventDefault();
    e.stopPropagation();
    if (!onDropIndex) return;
    const disabled = activeReadOnly || idx.primary;
    const title = idx.primary
      ? t("dropIndexPrimaryDisabled")
      : activeReadOnly
        ? t("listReadOnlyTitle")
        : undefined;
    const items: ContextMenuEntry[] = [
      {
        label: t("contextMenuDropIndex"),
        onSelect: () => onDropIndex(db, tbl, idx.name),
        disabled,
        title,
        danger: true,
      },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleDbContextMenu = (e: ContextMenuTriggerEvent, db: string) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuEntry[] = [];
    if (onCreateTable) {
      items.push({
        label: t("contextMenuCreateTable"),
        onSelect: () => onCreateTable(db),
        disabled: activeReadOnly,
        title: activeReadOnly ? t("listReadOnlyTitle") : undefined,
      });
    }
    if (onCreateRoutine) {
      const kinds: { kind: EditableObjectKind; key: "contextMenuCreateProcedure" | "contextMenuCreateFunction" | "contextMenuCreateTrigger" }[] = [
        { kind: "procedure", key: "contextMenuCreateProcedure" },
        { kind: "function", key: "contextMenuCreateFunction" },
        { kind: "trigger", key: "contextMenuCreateTrigger" },
      ];
      const entries = kinds
        .filter((k) => supportsRoutineEditing(activeDriver, k.kind))
        .map((k) => ({
          label: t(k.key),
          onSelect: () => onCreateRoutine(db, k.kind),
          disabled: activeReadOnly,
          title: activeReadOnly ? t("listReadOnlyTitle") : undefined,
        }));
      items.push(...submenuOrFlat(t("contextMenuCreateRoutineGroup"), entries, { icon: "routine" }));
    }
    if (onImportNewTable) {
      // 取り込みは書き込み (CREATE TABLE + INSERT) なので read_only では無効化する
      // (バックエンドの import_csv も read_only を拒否する)。
      items.push({
        label: t("contextMenuImportNewTable"),
        onSelect: () => onImportNewTable(db),
        disabled: activeReadOnly,
        title: activeReadOnly ? t("listReadOnlyTitle") : undefined,
      });
    }
    // データベース / スキーマの作成・削除 (#1190)。SQLite は DB がファイル単位なので
    // 出さない。書き込みなので read_only では無効化 (バックエンドも拒否する)。
    const nsKind = treeNamespaceKind(activeDriver);
    if (nsKind !== null && (onCreateNamespace || onDropNamespace)) {
      const roTitle = activeReadOnly ? t("listReadOnlyTitle") : undefined;
      if (onCreateNamespace) {
        items.push({
          label: t(activeDriver === "postgres" ? "contextMenuCreateNamespace" : "contextMenuCreateDatabase"),
          onSelect: () => onCreateNamespace(),
          disabled: activeReadOnly,
          title: roTitle,
        });
      }
      if (onDropNamespace) {
        const protectedNs = isProtectedNamespace(activeDriver, db);
        items.push({
          label: t(nsKind === "schema" ? "contextMenuDropSchema" : "contextMenuDropDatabase"),
          onSelect: () => onDropNamespace(db),
          disabled: activeReadOnly || protectedNs,
          title: activeReadOnly ? roTitle : protectedNs ? t("contextMenuNamespaceProtectedTitle") : undefined,
          danger: true,
        });
      }
      items.push({ separator: true });
    }
    items.push({ label: t("contextMenuDump"), onSelect: () => onDumpDatabase(db) });
    // ダンプの対になる「リストア」導線 (#973)。読み取り専用でも開ける — 書き込み文は
    // バックエンドが文ごとに拒否し、SELECT だけのスクリプトは実行できる。
    if (onRunScript) {
      items.push({ label: t("contextMenuRunScript"), onSelect: () => onRunScript(db) });
    }
    if (onSchemaExport) {
      items.push({ label: t("contextMenuSchemaExport"), onSelect: () => onSchemaExport(db) });
    }
    if (onShowDatabaseSizes) {
      items.push({ label: t("sizeMenuLabel"), onSelect: () => onShowDatabaseSizes(db) });
    }
    if (onCreateSandbox) {
      items.push({ label: t("contextMenuCreateSandbox"), onSelect: () => onCreateSandbox(db) });
    }
    // DB 全体の保守コマンド (#561)。SQLite/PostgreSQL のみ対象 (MySQL はグローバル
    // 保守文が無いため空)。データは消さないが書き込み/ロックを伴うため read_only で無効化。
    if (onRunDatabaseMaintenance) {
      const commands = databaseMaintenanceCommands(activeDriver);
      if (commands.length > 0) {
        const roTitle = activeReadOnly ? t("listReadOnlyTitle") : undefined;
        items.push({ separator: true });
        items.push(
          ...submenuOrFlat(
            t("contextMenuMaintenanceGroup"),
            commands.map((command) => ({
              label: t(MAINTENANCE_LABEL_KEYS[command.kind]),
              onSelect: () => onRunDatabaseMaintenance(db, command),
              disabled: activeReadOnly,
              title: roTitle,
            })),
            { icon: "tools" },
          ),
        );
      }
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // Fetch approximate row counts for a database and merge them into state. Best
  // effort: failures (e.g. a driver that doesn't support it) are swallowed so
  // the tree still renders without badges. Guarded by an in-flight set and a
  // session check so a stale connection's result can't clobber the new one.
  const loadRowEstimates = async (sid: string, db: string) => {
    if (estimatesInFlightRef.current.has(db)) return;
    estimatesInFlightRef.current.add(db);
    try {
      const list = await api.tableRowEstimates(sid, db);
      if (sessionIdRef.current !== sid) return;
      const map: Record<string, number | null> = {};
      for (const e of list) map[e.name] = e.estimate;
      setRowEstimates((prev) => ({ ...prev, [db]: map }));
    } catch {
      // Estimates are decorative; never block the tree on them.
    } finally {
      estimatesInFlightRef.current.delete(db);
    }
  };

  // テーブルコメント (#1002) をベストエフォートで取得する。SQLite は常に空。
  // `loadRowEstimates` と同じく接続切替後の古い結果は捨てる。
  async function loadTableComments(sid: string, db: string) {
    try {
      const list = await api.listTableComments(sid, db);
      if (sessionIdRef.current !== sid) return;
      setTableComments((prev) => ({ ...prev, [db]: tableCommentMap(list) }));
    } catch {
      // 装飾情報なのでツリー表示は止めない。
    }
  }

  const toggleDb = async (db: string) => {
    if (!sessionId) return;
    const isOpen = expandedDbs[db];
    if (isOpen) {
      const next = { ...expandedDbs, [db]: false };
      setExpandedDbs(next);
      persistTree(next, expandedTablesRef.current);
      return;
    }
    const next = { ...expandedDbs, [db]: true };
    setExpandedDbs(next);
    persistTree(next, expandedTablesRef.current);
    if (tables[db]) return;
    // Skip if a fetch is already in flight for this database — covers both
    // rapid collapse / re-expand and overlap with the schema-search eager loader.
    if (tablesInFlightRef.current.has(db)) return;
    tablesInFlightRef.current.add(db);
    try {
      const list = await listVisibleTables(sessionId, db);
      setTables((prev) => ({ ...prev, [db]: list }));
      void loadRowEstimates(sessionId, db);
      void loadTableComments(sessionId, db);
      // 非テーブルのスキーマオブジェクトもベストエフォートで取得する。
      // 接続切替中に旧セッションの結果を反映しないよう sid を確認する。
      const sid = sessionId;
      void api
        .listSchemaObjects(sid, db)
        .then((objs) => {
          if (sessionIdRef.current !== sid) return;
          setSchemaObjects((prev) => ({ ...prev, [db]: objs }));
        })
        .catch(() => {
          if (sessionIdRef.current !== sid) return;
          setSchemaObjects((prev) => ({ ...prev, [db]: [] }));
        });
    } catch (e) {
      setError(String(e));
    } finally {
      tablesInFlightRef.current.delete(db);
    }
  };

  const toggleTable = async (db: string, tbl: string) => {
    if (!sessionId) return;
    const key = tableKey(db, tbl);
    const isOpen = expandedTables[key];
    if (isOpen) {
      const next = { ...expandedTables, [key]: false };
      setExpandedTables(next);
      persistTree(expandedDbsRef.current, next);
      return;
    }
    const next = { ...expandedTables, [key]: true };
    setExpandedTables(next);
    persistTree(expandedDbsRef.current, next);
    if (tableColumns[key]) return;
    // Same in-flight guard as toggleDb: rapid collapse / re-expand mid-fetch
    // must not re-issue describeTable for the same table.
    if (columnsInFlightRef.current.has(key)) return;
    columnsInFlightRef.current.add(key);
    try {
      // 列とインデックスは独立なので並行に取得する (#1263)。インデックス一覧は
      // ベストエフォート: 取得失敗 (権限など) でも列表示は維持する。
      const idxPromise = api.listIndexes(sessionId, db, tbl).catch(() => [] as IndexInfo[]);
      const cols = await api.describeTable(sessionId, db, tbl);
      setTableColumns((prev) => ({ ...prev, [key]: cols }));
      const idx = await idxPromise;
      setTableIndexes((prev) => ({ ...prev, [key]: idx }));
    } catch (e) {
      setError(String(e));
    } finally {
      columnsInFlightRef.current.delete(key);
    }
  };

  // 検索は `useDeferredValue` で遅延させる (#1314)。入力欄 (`filter`) は即座に反映し、
  // ツリーの絞り込みとハイライト (重い) は入力を妨げない優先度で追従する。
  const deferredFilter = useDeferredValue(filter);
  const q = deferredFilter.trim().toLowerCase();
  const searching = q.length > 0;
  // Drag/keyboard reorder is disabled while a search filter is active — the
  // tree shows a filtered subset then, and reordering a partial view would
  // silently reorder the underlying full list in a way the user can't see.
  const reorderEnabled = !!onReorderProfiles && !searching;
  const activeExpanded = activeProfileId ? !!expandedProfiles[activeProfileId] : false;
  // The schema tree only shows the active connection, so its read-only flag
  // governs whether write-y table actions (Import CSV) are offered.
  const activeReadOnly = !!profiles.find((p) => p.id === activeProfileId)?.read_only;
  // 保守コマンドの SQL 方言はアクティブ接続のドライバで決まる (ツリーは
  // アクティブ接続のみを表示する)。
  const activeDriver = profiles.find((p) => p.id === activeProfileId)?.driver ?? "mysql";
  // ツリーの「データベース」階層が何を表すか (PostgreSQL ではスキーマ)。#1112
  const containerLabel =
    explorerContainerKind(activeDriver) === "schema"
      ? t("explorerContainerSchema")
      : t("explorerContainerDatabase");

  const profileMetaMatches = useCallback(
    (p: ConnectionProfile) =>
      p.name.toLowerCase().includes(q) ||
      p.host.toLowerCase().includes(q) ||
      !!p.database?.toLowerCase().includes(q) ||
      !!p.group?.toLowerCase().includes(q),
    [q],
  );

  // Schema-match helpers operate purely on the already-cached tree data
  // (`tables` / `tableColumns`); column matching only sees columns whose table
  // has been expanded at least once.
  //
  // 小文字化したテーブル名・列名のインデックスは、データが変わったときだけ作る
  // (#1314)。検索クエリが変わるたびに全テーブル・全列を `toLowerCase` し直さない。
  const lowerIndex = useMemo(() => {
    if (!searching) return null;
    const tableNames: Record<string, string[]> = {};
    for (const [db, list] of Object.entries(tables)) tableNames[db] = list.map((n) => n.toLowerCase());
    const columnNames: Record<string, string[]> = {};
    for (const [key, cols] of Object.entries(tableColumns)) {
      columnNames[key] = cols.map((c) => c.name.toLowerCase());
    }
    return { tableNames, columnNames };
    // `searching` は「インデックスが要るか」だけを表す (クエリ文字列の変化では作り直さない)。
  }, [searching, tables, tableColumns]);

  // クエリごとのマッチ結果 (DB / テーブル / 列) を 1 度だけ計算して集合で持つ。以前は
  // 描画の各所 (絞り込み・展開判定・ハイライト) が DB × テーブル × 列の判定を
  // 1 文字ごとに 2〜3 回繰り返していた。
  const schemaMatch = useMemo(() => {
    if (!lowerIndex) return null;
    const colMatch = new Set<string>();
    for (const [key, names] of Object.entries(lowerIndex.columnNames)) {
      if (names.some((n) => n.includes(q))) colMatch.add(key);
    }
    const tableMatch = new Set<string>();
    const dbMatch = new Set<string>();
    for (const db of databases ?? []) {
      let hit = db.toLowerCase().includes(q);
      const names = lowerIndex.tableNames[db];
      const list = tables[db];
      if (names && list) {
        for (let i = 0; i < list.length; i++) {
          const key = tableKey(db, list[i]);
          if (names[i].includes(q) || colMatch.has(key)) {
            tableMatch.add(key);
            hit = true;
          }
        }
      }
      if (hit) dbMatch.add(db);
    }
    return { colMatch, tableMatch, dbMatch };
  }, [lowerIndex, q, databases, tables]);
  const dbNodeMatches = (db: string) => schemaMatch?.dbMatch.has(db) ?? false;

  // The active connection's schema has a hit, so keep its profile visible even
  // when the query doesn't match the profile's own metadata.
  const activeSchemaMatches =
    searching && !!sessionId && databases !== null && databases.some(dbNodeMatches);

  // ツリーの構造が変わったコミットの直後に、止まり先の行が残っているか確認する (#1184)。
  // 判定はストアが覚えているマウント中のキーとの照合なので O(1) で、止まり先が消えて
  // いるときだけ DOM を読む。依存を明示しているので、打鍵・ホバー・フォーカス移動の
  // レンダーでは走らない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: ensureTabStop は本体で使うが、ツリー構造の変化 (profiles / databases / 展開状態など) の後にだけ止まり先を確認したいので、それらを再実行のトリガーとして意図的に依存へ含めている
  useLayoutEffect(() => {
    ensureTabStop();
  }, [
    ensureTabStop,
    profiles,
    q,
    sessionId,
    activeProfileId,
    databases,
    tables,
    tableColumns,
    tableIndexes,
    schemaObjects,
    expandedProfiles,
    expandedDbs,
    expandedTables,
    expandedGroups,
    favorites,
    recent,
  ]);

  // Eagerly load every database's table list while a schema search is active so
  // table-name matches surface without the user expanding each database first.
  // Gated on the active connection being expanded to avoid loading on a plain
  // profile-name filter. Columns stay lazy (loaded on table expand).
  useEffect(() => {
    if (!searching || !sessionId || databases === null || !activeExpanded) return;
    const missing = databases.filter(
      (db) => tables[db] === undefined && !tablesInFlightRef.current.has(db),
    );
    if (missing.length === 0) return;
    // 全 DB のテーブル一覧を SQL 1 本 (`list_tables_all`) で取得し、state へは 1 回の
    // 更新でまとめて反映する (#1263)。以前は DB 数ぶんの `list_tables` を無制限に
    // 並列で呼び、1 件ごとに再レンダーしていた。
    const sid = sessionId;
    for (const db of missing) tablesInFlightRef.current.add(db);
    api
      .listTablesAll(sid)
      .then((all) => {
        if (sessionIdRef.current !== sid) return;
        const byDb = new Map(all.map((d) => [d.database, d.tables]));
        setTables((prev) => {
          const next = { ...prev };
          for (const db of missing) {
            // 手動展開などで先に埋まった DB は上書きしない。結果に無い DB は空として
            // 確定させ、再取得のループを防ぐ。
            if (next[db] === undefined) {
              next[db] = (byDb.get(db) ?? []).filter((tbl) => !isSandboxShadowTableName(tbl));
            }
          }
          return next;
        });
      })
      .catch(() => {})
      .finally(() => {
        for (const db of missing) tablesInFlightRef.current.delete(db);
      });
  }, [searching, sessionId, databases, activeExpanded, tables]);

  const visibleProfiles = profiles.filter((p) => {
    if (!searching) return true;
    if (profileMetaMatches(p)) return true;
    if (p.id === activeProfileId && activeSchemaMatches) return true;
    return false;
  });

  /** Profiles grouped by their `group` field. `null` key = ungrouped. */
  const grouped = useMemo(() => {
    const anyGrouped = profiles.some((p) => p.group);
    if (!anyGrouped) return null;
    const map = new Map<string | null, ConnectionProfile[]>();
    for (const p of visibleProfiles) {
      const key = p.group ?? null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    const groups: { name: string | null; profiles: ConnectionProfile[] }[] = [];
    // #786: 表示順は永続化済み `groupOrder` を土台にした並び (触っていないグループ
    // はアルファベット順の既定挙動のまま — `applyGroupOrder` を参照)。
    const names = applyGroupOrder(
      Array.from(map.keys()).filter((k): k is string => k !== null),
      groupOrder,
    );
    for (const name of names) groups.push({ name, profiles: map.get(name)! });
    const ungrouped = map.get(null);
    if (ungrouped && ungrouped.length > 0) groups.push({ name: null, profiles: ungrouped });
    return groups;
  }, [profiles, visibleProfiles, groupOrder]);

  // グループ見出しがある (`grouped !== null`) 場合、プロファイル行はグループ行の
  // 1 段下になるため、その配下 (DB/テーブル/カラム…) も `aria-level` が 1 段深くなる。
  const groupLevel = grouped !== null ? 1 : 0;

  const profileStatus = (p: ConnectionProfile): "connected" | "connecting" | "error" | "idle" => {
    if (connectingId === p.id) return "connecting";
    if (errorProfileId === p.id && activeProfileId !== p.id) return "error";
    if (activeProfileId === p.id && sessionId) return "connected";
    // 背景で開いたままの接続 (アクティブではないがセッション生存) も接続済み表示。
    if (openProfileIds?.has(p.id)) return "connected";
    return "idle";
  };

  const statusLabel = (s: "connected" | "connecting" | "error" | "idle") => {
    switch (s) {
      case "connected": return t("statusBadge_connected");
      case "connecting": return t("statusBadge_connecting");
      case "error": return t("statusBadge_error");
      case "idle": return t("statusBadge_idle");
    }
  };

  // 行 (`memo` 化した `TableNode` など) が共有するハンドラ群。各関数は `useEvent` で
  // 「常に最新の自分」へ委譲するので、このオブジェクトは 1 度作ったら同一参照のまま
  // (行の props / context が変わらず、描き直されない)。
  const pickTable = useEvent((db: string, tbl: string) => onPickTable(db, tbl));
  const toggleTableEvent = useEvent((db: string, tbl: string) => void toggleTable(db, tbl));
  const toggleFavoriteEvent = useEvent((db: string, tbl: string) => onToggleFavorite?.(db, tbl));
  const openObjectDefinitionEvent = useEvent((db: string, kind: string, name: string, id: string | null) =>
    onOpenObjectDefinition?.(db, kind, name, id),
  );
  const tableMenuEvent = useEvent(handleTableContextMenu);
  const viewMenuEvent = useEvent(handleViewContextMenu);
  const routineMenuEvent = useEvent(handleRoutineContextMenu);
  const columnMenuEvent = useEvent(handleColumnContextMenu);
  const insertColumnEvent = useEvent((db: string, tbl: string, column: string) =>
    onInsertColumn?.(db, tbl, column, false),
  );
  const indexMenuEvent = useEvent(handleIndexContextMenu);
  const toggleDbEvent = useEvent((db: string) => void toggleDb(db));
  const dbMenuEvent = useEvent(handleDbContextMenu);
  const treeActions = useMemo<TreeActions>(
    () => ({
      store: tabStopStore,
      treeTooltip: treeTooltipProps,
      columnTooltip: columnTooltipProps,
      makeKeyDown: makeTreeItemKeyDown,
      pickTable,
      toggleTable: toggleTableEvent,
      toggleFavorite: toggleFavoriteEvent,
      openObjectDefinition: openObjectDefinitionEvent,
      tableMenu: tableMenuEvent,
      viewMenu: viewMenuEvent,
      routineMenu: routineMenuEvent,
      columnMenu: columnMenuEvent,
      insertColumn: insertColumnEvent,
      indexMenu: indexMenuEvent,
      toggleDb: toggleDbEvent,
      dbMenu: dbMenuEvent,
      activeTableIndicatorId,
    }),
    [
      tabStopStore,
      treeTooltipProps,
      columnTooltipProps,
      makeTreeItemKeyDown,
      pickTable,
      toggleTableEvent,
      toggleFavoriteEvent,
      openObjectDefinitionEvent,
      tableMenuEvent,
      viewMenuEvent,
      routineMenuEvent,
      columnMenuEvent,
      insertColumnEvent,
      indexMenuEvent,
      toggleDbEvent,
      dbMenuEvent,
      activeTableIndicatorId,
    ],
  );

  // `partitionDatabaseNodes` の結果を DB ごとに覚えておく (#1314)。毎レンダー作り直すと
  // ビューのノードが新しいオブジェクトになり、行の `memo` が効かなくなる。
  const partitionCacheRef = useRef(
    new Map<string, { tables: string[]; objects: SchemaObject[] | undefined; groups: ReturnType<typeof partitionDatabaseNodes> }>(),
  );
  const partitionFor = (db: string, dbTables: string[], objects: SchemaObject[] | undefined) => {
    const cached = partitionCacheRef.current.get(db);
    if (cached && cached.tables === dbTables && cached.objects === objects) return cached.groups;
    const groups = partitionDatabaseNodes(dbTables, objects);
    partitionCacheRef.current.set(db, { tables: dbTables, objects, groups });
    return groups;
  };

  // アクティブ接続のスキーマのサブツリーを、いま見えている行のフラットな配列にする (#1315)。
  // 展開状態・検索時の強制展開・振り分けは `buildExplorerRows` (純関数) が持つ。
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const activeSchemaFiltered = searching && !!activeProfile && !profileMetaMatches(activeProfile);
  const activeTableDb = activeTable?.database;
  const activeTableName = activeTable?.table;
  const hasObjectDefinitionOpener = !!onOpenObjectDefinition;
  // biome-ignore lint/correctness/useExhaustiveDependencies: partitionFor は毎レンダーで作り直される関数だが、中身は ref (partitionCacheRef) のキャッシュだけを使う。依存に入れると毎回再計算されるため除外する (下の依存配列に入力値を列挙済み)
  const explorerRows = useMemo<ExplorerRow[]>(() => {
    if (!activeProfileId || !sessionId) return [];
    return buildExplorerRows({
      databases,
      tables,
      schemaObjects,
      tableColumns,
      tableIndexes,
      expandedDbs,
      expandedTables,
      query: q,
      schemaFiltered: activeSchemaFiltered,
      matchers: schemaMatch
        ? {
            db: (db) => schemaMatch.dbMatch.has(db),
            table: (db, tbl) => schemaMatch.tableMatch.has(tableKey(db, tbl)),
            column: (db, tbl) => schemaMatch.colMatch.has(tableKey(db, tbl)),
          }
        : null,
      partition: partitionFor,
      showObjects: hasObjectDefinitionOpener,
      favorites: favorites ?? EMPTY_REFS,
      recent: recent ?? EMPTY_REFS,
      rowEstimate: (db, tbl) => rowEstimates[db]?.[tbl],
      comment: (db, tbl) => tableComments[db]?.[tbl],
      // 現在結果パネルに開いているテーブルかどうか (#982)。ツリーはアクティブ接続のみを
      // 表示するので db/table の一致だけで十分 (プロファイル跨ぎの衝突はない)。
      isActiveTable: (db, tbl) => activeTableDb === db && activeTableName === tbl,
    });
    // `partitionFor` は ref を介したキャッシュだけを使うので依存に含めない。
  }, [
    activeProfileId,
    sessionId,
    databases,
    tables,
    schemaObjects,
    tableColumns,
    tableIndexes,
    expandedDbs,
    expandedTables,
    q,
    activeSchemaFiltered,
    schemaMatch,
    hasObjectDefinitionOpener,
    favorites,
    recent,
    rowEstimates,
    tableComments,
    activeTableDb,
    activeTableName,
  ]);
  const activeRowKey = activeTableDb !== undefined && activeTableName !== undefined
    ? `tbl:${tableKey(activeTableDb, activeTableName)}`
    : null;
  // スキーマ行リストの位置を測り直すきっかけ: 上にあるプロファイル / グループの開閉・増減。
  // 値 (文字列) で比べるので、`visibleProfiles` が毎レンダー作り直されても、構造が同じなら
  // 同じトークンになる (再レンダーのたびに測り直さないため, #1342)。
  const rowListLayoutToken = [
    visibleProfiles.map((p) => `${p.id}\u0001${p.group ?? ""}`).join("\u0000"),
    // グループは「キー無し = 開いている」なので、false も含めて (キー, 値) を並べる。
    Object.entries(expandedGroups).map(([k, v]) => `${k}\u0001${v}`).join("\u0000"),
    Object.entries(expandedProfiles).map(([k, v]) => `${k}\u0001${v}`).join("\u0000"),
  ].join("\u0002");


  const renderProfile = (p: ConnectionProfile, siblingIds: string[]) => {
    const profileTreeKey = `profile:${p.id}`;
    const isActive = p.id === activeProfileId;
    const isOpen = !!expandedProfiles[p.id];
    const status = profileStatus(p);
    const accent = normalizeChipColor(p.color) ?? undefined;
    const refreshing = refreshingSession === sessionId;
    // Left stripe + tint priority: production (red, always wins) > custom color >
    // active accent > none. A custom color also overrides the active accent
    // stripe, matching the previous inline-style behaviour.
    let borderLeftColor: string;
    let rowBg: string | undefined;
    if (p.is_production) {
      const danger = semanticColorVar("danger", "solid");
      borderLeftColor = danger;
      rowBg = isActive
        ? `color-mix(in srgb, ${danger} 12%, var(--bg-active))`
        : `color-mix(in srgb, ${danger} 6%, transparent)`;
    } else if (accent) {
      borderLeftColor = accent;
      rowBg = isActive ? "var(--bg-active)" : undefined;
    } else if (isActive) {
      borderLeftColor = "var(--accent)";
      rowBg = "var(--bg-active)";
    } else {
      borderLeftColor = "transparent";
      rowBg = undefined;
    }
    const subtitle =
      p.driver === "sqlite"
        ? p.file_path
          ? p.file_path.split(/[/\\]/).pop() || p.file_path
          : "SQLite"
        : `${p.host}:${p.port}${p.database ? ` / ${p.database}` : ""}`;

    const driverIcon = driverIconName(p.driver);

    return (
      <MotionReorderNode
        key={p.id}
        // ドラッグ並べ替え (#786): Reorder.Item の `value`。`reorderEnabled` が
        // false (コールバック未接続、または検索フィルタ中) のときは `drag` を
        // 無効化して従来どおり静的に並べる (TabBar と同じ方式)。
        value={p.id}
        drag={reorderEnabled}
        whileDrag={{ scale: 1.02, boxShadow: "var(--shadow-lg)", zIndex: 3 }}
        onDragStart={reorderEnabled ? () => setDropIndicator(p.id, false) : undefined}
        onDragEnd={reorderEnabled ? () => setDropIndicator(null) : undefined}
        {...variants.fade}
        transition={transitions.crossfade}
      >
        <TabStop treeKey={profileTreeKey}>
        {({ tabIndex, onFocus }) => (
        <MotionTreeRow
          ref={(el: HTMLElement | null) => {
            if (el) profileRowRefs.current.set(p.id, el);
            else profileRowRefs.current.delete(p.id);
          }}
          pt="1.25"
          pb="1.25"
          pr="2.5"
          pl="1.25"
          // プロファイルカラー / 本番 / アクティブを左端のアクセントバーで示す。
          // 識別性を上げるため 4px に。全行で同一幅 (色なしは transparent) にして
          // 行頭テキストの揃えを保つ。
          borderLeftWidth="4px"
          borderLeftColor={borderLeftColor}
          bg={rowBg}
          // `DropInsertionMarker` (下記) を絶対配置するための基準。
          position="relative"
          _hover={{ bg: rowBg ?? "app.hover" }}
          // ホバーで控えめに拡大 + 影を出すモーション。
          // prefers-reduced-motion はルートの MotionConfig が自動抑制する。
          whileHover={{ scale: 1.01, boxShadow: "var(--shadow-md)" }}
          transition={springs.gentle}
          style={{ transformOrigin: "center left" }}
          data-tree-key={profileTreeKey}
          data-testid="connection-profile-row"
          data-profile-name={p.name}
          onClick={() => handleProfileClick(p)}
          onContextMenu={(e) => handleProfileContextMenu(e, p)}
          onKeyDown={handleProfileRowKeyDown(p, siblingIds)}
          onFocus={onFocus}
          tabIndex={tabIndex}
          role="treeitem"
          aria-level={groupLevel + 1}
          aria-expanded={isOpen}
          // 共有 `Tooltip` (#814) で単純に包むと、この行自体が `AnimatePresence`
          // の直接の子として追跡される `Reorder.Item` (ドラッグ並べ替え #786) のため、
          // `TabBar` の `MotionTab` と同じ理由で開閉/並べ替えアニメーションが壊れる
          // (`Tooltip` はトリガーを Fragment で包むため、間に挟むと `AnimatePresence`
          // から見た直接の子が変わってしまう)。そのため行自体は `treeTooltipProps`
          // (#884、下記スキーマツリー行と同じ「1 つの共有ツールチップ + 座標だけ
          // 報告するイベント委譲」方式) を使う — ラッパ要素を増やさないので
          // アニメーションに影響しない。
          {...treeTooltipProps(
            p.driver === "sqlite"
              ? p.file_path ?? p.name
              : `${p.user}@${p.host}:${p.port}${p.database ? "/" + p.database : ""}${p.ssh ? " " + t("listVia", { host: p.ssh.host }) : ""}`,
          )}
        >
          <TreeChevron transform={isOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
          {/* ドライバ別ブランドアイコン (MySQL/PostgreSQL/SQLite) でひと目で種別が
              分かるようにする。ユーザ設定のカスタム色があればそれで着色して
              個別識別性も残し、無ければドライバのブランド色を使う。プロファイルカラーは
              左端のアクセントバーにも出る。未知ドライバは汎用 server アイコン。 */}
          <TreeIcon color={accent ?? (driverIcon ? driverColor(p.driver) : "app.accent")} aria-hidden>
            <Icon name={driverIcon ?? "server"} />
          </TreeIcon>
          <chakra.span
            display="flex"
            flexDirection="column"
            justifyContent="center"
            gap="0.25"
            flex="1"
            minWidth={0}
            lineHeight="1.25"
          >
            <chakra.span
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              fontWeight={isActive ? 700 : 600}
              fontSize="md"
              color={isActive ? "app.text" : undefined}
            >
              <HighlightText text={p.name} query={q} />
            </chakra.span>
            <chakra.span
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              fontSize="2xs"
              fontFamily="mono"
              color={isActive ? "app.textSecondary" : "app.textMuted"}
              {...treeTooltipProps(subtitle)}
            >
              {subtitle}
            </chakra.span>
          </chakra.span>
          {/* 本番/読取専用バッジは ConnectionList・TitleBar・本番接続確認ダイアログで
              共有する `ProfileBadges` (#663)。配色決定は `profileIdentity.ts` /
              `semanticColors.ts` に一元化済みで、ここに色を持たない。 */}
          <ProfileBadges isProduction={p.is_production} readOnly={p.read_only} />
          {/* スキーマ更新ボタンはアクティブ接続でのみ表示する。refreshSchema は
              アクティブな sessionId を対象にするため、背景接続の行に出すと別接続を
              更新してしまい紛らわしい (#複数同時接続)。背景接続は接続済みドットのみ。 */}
          {status === "connected" && isActive && (
            <Tooltip label={t("treeRefreshTitle")} focusableWrapper={refreshing}>
              <chakra.button
                type="button"
                flexShrink={0}
                display="inline-flex"
                alignItems="center"
                justifyContent="center"
                p="0.5"
                color="app.textMuted"
                bg="transparent"
                border="none"
                borderRadius="sm"
                cursor="pointer"
                _hover={refreshing ? undefined : { color: "app.text", bg: "var(--bg-hover, var(--bg-muted))" }}
                _disabled={{ cursor: "default" }}
                onClick={(e) => {
                  e.stopPropagation();
                  void refreshSchema();
                }}
                disabled={refreshing}
                aria-label={t("treeRefresh")}
              >
                <chakra.span
                  display="inline-flex"
                  animation={refreshing ? "spinner-rotate var(--dur-spin) linear infinite" : undefined}
                >
                  <Icon name="refresh" size={ICON_SIZES.sm} />
                </chakra.span>
              </chakra.button>
            </Tooltip>
          )}
          <Tooltip label={statusLabel(status)} focusableWrapper>
            <chakra.span
              display="inline-block"
              width="8px"
              height="8px"
              borderRadius="50%"
              flexShrink={0}
              transitionProperty="background, box-shadow"
              transitionDuration="var(--dur-med)"
              transitionTimingFunction="var(--ease)"
              {...STATUS_DOT_STYLE[status]}
              aria-label={statusLabel(status)}
            />
          </Tooltip>
          {/* 並べ替え (ドラッグ中/キーボード移動直後) の着地位置マーカー。TabBar と
              同じ共有実装 (#1007)。 */}
          <DropInsertionMarker orientation="horizontal" visible={dropIndicator === p.id} />
        </MotionTreeRow>
        )}
        </TabStop>

        <TreeCollapse open={!!(isOpen && isActive && sessionId)}>
          <TreeChildren>
            {isActive && sessionId && (
              <SchemaRowList
                rows={explorerRows}
                level={groupLevel}
                q={q}
                removableFavorites={!!onToggleFavorite}
                containerLabel={containerLabel}
                scrollRef={treeRef}
                handleRef={schemaListRef}
                store={tabStopStore}
                activeKey={activeRowKey}
                layoutToken={rowListLayoutToken}
              />
            )}
          </TreeChildren>
        </TreeCollapse>
      </MotionReorderNode>
    );
  };

  return (
    <TreeActionsContext.Provider value={treeActions}>
    <Flex direction="column" overflow="hidden" flex="1">
      {/* ツールチップの state はここ (ツリー本体の外) に閉じ込める。ホバーの出入りで
          描き直されるのはこの 2 つだけ (#1314)。 */}
      <TreeTooltipLayer bindRef={treeTooltipBindRef} />
      <ColumnTooltipLayer bindRef={columnTooltipBindRef} />
      <Box px="2.5" py="2" borderBottom="1px solid" borderColor="app.borderSubtle">
        <Input
          ref={filterInputRef}
          type="search"
          py="1.25"
          fontSize="sm"
          placeholder={t("listSearchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </Box>

      {error && (
        // サイドバー上端に全幅で敷く帯なので、角丸と左右上の枠を外して下線だけ残す。
        <Callout
          tone="danger"
          px="3"
          py="1.5"
          fontSize="xs"
          borderRadius="0"
          borderWidth="0"
          borderBottomWidth="1px"
        >
          {error}
        </Callout>
      )}

      {profiles.length === 0 ? (
        <EmptyState
          illustration={<WelcomeIllustration />}
          icon="server"
          title={t("listEmptyTitle")}
          description={t("listEmptyDesc")}
          action={{ label: t("listCreateFirst"), onClick: onCreate, testId: "connection-create-first" }}
        />
      ) : visibleProfiles.length === 0 ? (
        <Text color="app.textMuted" p="3">{t("listNoMatches")}</Text>
      ) : (
        <Box ref={treeRef} flex="1" overflowY="auto" py="1" fontSize="md" color="app.text" role="tree">
          {grouped === null ? (
            // ungrouped の 1 本のフラットな並び: そのままプロファイルの並び順
            // (ドラッグ/キーボードで動かせる)。
            (() => {
              const ids = visibleProfiles.map((p) => p.id);
              return (
                <Reorder.Group
                  as="div"
                  axis="y"
                  values={ids}
                  onReorder={(proposed: string[]) => handleProfilesDrag(ids, proposed)}
                  style={{ display: "flex", flexDirection: "column", listStyle: "none", margin: 0, padding: 0 }}
                >
                  <AnimatePresence initial={false}>
                    {visibleProfiles.map((p) => renderProfile(p, ids))}
                  </AnimatePresence>
                </Reorder.Group>
              );
            })()
          ) : (
            (() => {
              // 名前付きグループ (ドラッグ/キーボードで見出しごと並べ替え可能) と、
              // 常に末尾に固定される未分類セクション (既存の既定挙動を維持) を分ける。
              const namedGroups = grouped.filter(
                (g): g is { name: string; profiles: ConnectionProfile[] } => g.name !== null,
              );
              const ungroupedGroup = grouped.find((g) => g.name === null);
              const namedGroupKeys = namedGroups.map((g) => g.name);

              const renderGroupBlock = (g: { name: string; profiles: ConnectionProfile[] }) => {
                const key = g.name;
                const groupOpen = expandedGroups[key] !== false;
                const memberIds = g.profiles.map((p) => p.id);
                return (
                  <MotionReorderNode
                    key={key}
                    value={key}
                    drag={reorderEnabled}
                    whileDrag={{ scale: 1.01, boxShadow: "var(--shadow-lg)", zIndex: 3 }}
                    onDragStart={reorderEnabled ? () => setDropIndicator(`group:${key}`, false) : undefined}
                    onDragEnd={reorderEnabled ? () => setDropIndicator(null) : undefined}
                  >
                    <TreeNode>
                      <TabStop treeKey={`group:${key}`}>
                      {({ tabIndex, onFocus }) => (
                      <Box
                        ref={(el: HTMLElement | null) => {
                          if (el) groupRowRefs.current.set(key, el);
                          else groupRowRefs.current.delete(key);
                        }}
                        display="flex"
                        alignItems="center"
                        gap="1"
                        whiteSpace="nowrap"
                        overflow="hidden"
                        userSelect="none"
                        cursor="pointer"
                        pt={TREE_GROUP_HEADING_PY}
                        pr="2.5"
                        pb={TREE_GROUP_HEADING_PY}
                        pl="1.5"
                        textStyle="overline"
                        bg="app.surfaceMuted"
                        borderTop="1px solid"
                        borderTopColor="app.borderSubtle"
                        borderBottom="1px solid"
                        borderBottomColor="app.borderSubtle"
                        borderLeft="2px solid transparent"
                        // `DropInsertionMarker` (下記) を絶対配置するための基準。
                        position="relative"
                        transitionProperty="background, color, border-color, box-shadow"
                        transitionDuration="var(--dur-fast)"
                        transitionTimingFunction="var(--ease)"
                        _hover={{ bg: "app.hover", color: "app.text" }}
                        data-tree-key={`group:${key}`}
                        onClick={() =>
                          setExpandedGroups((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }))
                        }
                        onKeyDown={handleGroupRowKeyDown(key, namedGroupKeys)}
                        onFocus={onFocus}
                        tabIndex={tabIndex}
                        role="treeitem"
                        aria-level={1}
                        aria-expanded={groupOpen}
                      >
                        <TreeChevron transform={groupOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
                        {/* グループ名のイニシャルアバター (#663)。 */}
                        <GroupAvatar name={g.name} size={16} />
                        <chakra.span flex="1" fontWeight={600} overflow="hidden" textOverflow="ellipsis">
                          {g.name}
                        </chakra.span>
                        <TreeBadge textTransform="none" letterSpacing="0">{g.profiles.length}</TreeBadge>
                        {/* 並べ替え (ドラッグ中/キーボード移動直後) の着地位置マーカー。
                            TabBar と同じ共有実装 (#1007)。 */}
                        <DropInsertionMarker orientation="horizontal" visible={dropIndicator === `group:${key}`} />
                      </Box>
                      )}
                      </TabStop>
                      <TreeCollapse open={groupOpen}>
                        <Reorder.Group
                          as="div"
                          axis="y"
                          values={memberIds}
                          onReorder={(proposed: string[]) => handleProfilesDrag(memberIds, proposed)}
                          style={{ display: "flex", flexDirection: "column", listStyle: "none", margin: 0, padding: 0 }}
                        >
                          <AnimatePresence initial={false}>
                            {g.profiles.map((p) => renderProfile(p, memberIds))}
                          </AnimatePresence>
                        </Reorder.Group>
                      </TreeCollapse>
                    </TreeNode>
                  </MotionReorderNode>
                );
              };

              return (
                <>
                  <Reorder.Group
                    as="div"
                    axis="y"
                    values={namedGroupKeys}
                    onReorder={(proposed: string[]) => handleGroupsDrag(namedGroupKeys, proposed)}
                    style={{ display: "flex", flexDirection: "column", listStyle: "none", margin: 0, padding: 0 }}
                  >
                    {namedGroups.map(renderGroupBlock)}
                  </Reorder.Group>
                  {ungroupedGroup && (() => {
                    const key = "__ungrouped__";
                    const groupOpen = expandedGroups[key] !== false;
                    const memberIds = ungroupedGroup.profiles.map((p) => p.id);
                    return (
                      <TreeNode key={key}>
                        <TabStop treeKey={`group:${key}`}>
                        {({ tabIndex, onFocus }) => (
                        <Box
                          display="flex"
                          alignItems="center"
                          gap="1"
                          whiteSpace="nowrap"
                          overflow="hidden"
                          userSelect="none"
                          cursor="pointer"
                          pt={TREE_GROUP_HEADING_PY}
                          pr="2.5"
                          pb={TREE_GROUP_HEADING_PY}
                          pl="1.5"
                          textStyle="overline"
                          bg="app.surfaceMuted"
                          borderTop="1px solid"
                          borderTopColor="app.borderSubtle"
                          borderBottom="1px solid"
                          borderBottomColor="app.borderSubtle"
                          borderLeft="2px solid transparent"
                          transitionProperty="background, color, border-color, box-shadow"
                          transitionDuration="var(--dur-fast)"
                          transitionTimingFunction="var(--ease)"
                          _hover={{ bg: "app.hover", color: "app.text" }}
                          data-tree-key={`group:${key}`}
                          onClick={() =>
                            setExpandedGroups((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }))
                          }
                          // 名前付きグループ見出しと同じキーボード対応 (Enter/Space で
                          // 開閉)。未分類は並べ替え不可のため矢印キーの移動は
                          // moveItemBy が no-op になり、開閉だけが効く。
                          onKeyDown={handleGroupRowKeyDown(key, namedGroupKeys)}
                          onFocus={onFocus}
                          tabIndex={tabIndex}
                          role="treeitem"
                          aria-level={1}
                          aria-expanded={groupOpen}
                        >
                          <TreeChevron transform={groupOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
                          <chakra.span flex="1" fontWeight={600} overflow="hidden" textOverflow="ellipsis">
                            {t("listGroupUngrouped")}
                          </chakra.span>
                          <TreeBadge textTransform="none" letterSpacing="0">{ungroupedGroup.profiles.length}</TreeBadge>
                        </Box>
                        )}
                        </TabStop>
                        <TreeCollapse open={groupOpen}>
                          <Reorder.Group
                            as="div"
                            axis="y"
                            values={memberIds}
                            onReorder={(proposed: string[]) => handleProfilesDrag(memberIds, proposed)}
                            style={{ display: "flex", flexDirection: "column", listStyle: "none", margin: 0, padding: 0 }}
                          >
                            <AnimatePresence initial={false}>
                              {ungroupedGroup.profiles.map((p) => renderProfile(p, memberIds))}
                            </AnimatePresence>
                          </Reorder.Group>
                        </TreeCollapse>
                      </TreeNode>
                    );
                  })()}
                </>
              );
            })()
          )}
        </Box>
      )}

      {sandboxes && sandboxes.length > 0 && onOpenSandbox && onReviewSandbox && onDiscardSandbox && (
        <SandboxSection
          sandboxes={sandboxes}
          activeProfileId={activeProfileId}
          openProfileIds={openProfileIds}
          connectingId={connectingId}
          onOpen={onOpenSandbox}
          onReview={onReviewSandbox}
          onDiscard={onDiscardSandbox}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </Flex>
    </TreeActionsContext.Provider>
  );
}));

const TooltipDt = chakra("dt", { base: { color: "app.textMuted", whiteSpace: "nowrap" } });
const TooltipDd = chakra("dd", { base: { m: 0, fontFamily: "mono", wordBreak: "break-all" } });

/**
 * Hover card for a schema-browser column. Shows type, NULL-ability, default,
 * key kind and (for foreign keys) the referenced table/column. Positioned with
 * `position: fixed` against a snapshot of the row's rectangle, flipping to the
 * left / clamping to the viewport when it would overflow. Rendered invisibly on
 * the first frame so it can measure itself before committing a position.
 */
function ColumnTooltip({ col, anchor }: { col: TableColumnInfo; anchor: TooltipRect }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: col は測定対象の列が変わったときに吹き出しを再配置するためのトリガー (本体では ref 経由で DOM を測るだけ) として意図的に依存へ含めている
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = el.getBoundingClientRect();
    // 測定→クランプ→フリップは Tooltip プリミティブ (#814) と共有の
    // `computeTooltipPosition` に一本化済み。行の高さ全体を対象に中央寄せすると
    // 縦長の行ではカーソル位置から離れて見えるため、"right" + align="start" で
    // 行の上端に揃える (元のインライン実装と同じ見た目)。
    setPos(
      computeTooltipPosition(anchor, size, "right", 8, { width: window.innerWidth, height: window.innerHeight }, "start"),
    );
  }, [col, anchor]);

  const keyLabel =
    col.key === "PRI"
      ? t("colTipKeyPrimary")
      : col.key === "UNI"
        ? t("colTipKeyUnique")
        : col.key === "MUL"
          ? t("colTipKeyIndex")
          : col.key;

  const reference =
    col.referenced_table === null
      ? null
      : col.referenced_column
        ? `${col.referenced_table}.${col.referenced_column}`
        : col.referenced_table;

  return (
    <Box
      ref={ref}
      role="tooltip"
      position="fixed"
      zIndex="popover"
      maxWidth="280px"
      bg="app.surface"
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="md"
      boxShadow="md"
      py="2"
      px="2.5"
      fontSize="sm"
      color="app.text"
      pointerEvents="none"
      left={`${pos ? pos.left : anchor.right + 8}px`}
      top={`${pos ? pos.top : anchor.top}px`}
      visibility={pos ? "visible" : "hidden"}
    >
      <chakra.div fontFamily="mono" fontWeight={600} mb="1.5" wordBreak="break-all">
        {col.name}
      </chakra.div>
      <chakra.dl display="grid" gridTemplateColumns="auto 1fr" rowGap="0.5" columnGap="2.5" m={0}>
        <TooltipDt>{t("colTipType")}</TooltipDt>
        <TooltipDd>{col.data_type}</TooltipDd>
        <TooltipDt>{t("colTipNullable")}</TooltipDt>
        <TooltipDd>{col.nullable ? t("colTipYes") : t("colTipNo")}</TooltipDd>
        {col.default !== null && (
          <>
            <TooltipDt>{t("colTipDefault")}</TooltipDt>
            <TooltipDd>{col.default}</TooltipDd>
          </>
        )}
        {col.key && (
          <>
            <TooltipDt>{t("colTipKey")}</TooltipDt>
            <TooltipDd>{keyLabel}</TooltipDd>
          </>
        )}
        {reference && (
          <>
            <TooltipDt>{t("colTipReferences")}</TooltipDt>
            <TooltipDd>{reference}</TooltipDd>
          </>
        )}
        {col.extra && (
          <>
            <TooltipDt>{t("colTipExtra")}</TooltipDt>
            <TooltipDd>{col.extra}</TooltipDd>
          </>
        )}
        {col.comment && col.comment.trim() !== "" && (
          <>
            <TooltipDt>{t("colTipComment")}</TooltipDt>
            <TooltipDd>{col.comment}</TooltipDd>
          </>
        )}
      </chakra.dl>
    </Box>
  );
}

