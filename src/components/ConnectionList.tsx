import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, Text, VisuallyHidden } from "@chakra-ui/react";
import { AnimatePresence } from "motion/react";
import { api, ConnectionProfile, IndexInfo, SchemaObject, TableColumnInfo } from "../api/tauri";
import type { TableRef } from "../tableQuickAccess";
import { tableRefEquals } from "../tableQuickAccess";
import { loadSchemaTree, saveSchemaTree } from "../schemaTreeState";
import { formatRowEstimate } from "./rowEstimate";
import { useT } from "../i18n";
import { springs, transitions, variants } from "../motion";
import { ICON_SIZES, Icon, type IconName } from "./Icon";
import { EmptyState } from "./EmptyState";
import { WelcomeIllustration } from "./illustrations";
import { SkeletonRow } from "./Skeleton";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { GroupAvatar, ProfileBadges } from "./ProfileBadge";
import { normalizeChipColor } from "../profileIdentity";
import {
  databaseMaintenanceCommands,
  tableMaintenanceCommands,
  type MaintenanceCommand,
  type MaintenanceKind,
} from "./maintenanceCommands";
import { Input } from "./ui";
import type { I18nKey } from "../i18n";
import {
  MotionTreeNode,
  MotionTreeRow,
  TreeBadge,
  TreeChevron,
  TreeCollapse,
  TreeIcon,
  TreeLabel,
  TreeNode,
  TreeRow,
} from "./tree";

const tableKey = (db: string, tbl: string) => `${db}::${tbl}`;

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
        borderRadius="2px"
        px="1px"
      >
        {text.slice(idx, idx + query.length)}
      </chakra.mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/** ドライバ名 (プロファイルの自由文字列) を Icon のブランドロゴ名へ正規化する。
 *  未知のドライバは null を返し、呼び出し側で汎用アイコンへフォールバックする。 */
function driverIconName(driver: string): IconName | null {
  switch (driver.toLowerCase()) {
    case "mysql":
    case "mariadb":
      return "mysql";
    case "postgres":
    case "postgresql":
      return "postgres";
    case "sqlite":
    case "sqlite3":
      return "sqlite";
    default:
      return null;
  }
}

/** ドライバごとのブランドアクセント色。ライト/ダーク両テーマで視認できる中間色を
 *  選んでいる (暗い純正色だとダークテーマで沈むため)。 */
function driverColor(driver: string): string {
  switch (driverIconName(driver)) {
    case "mysql":
      return "#00758f";
    case "postgres":
      return "#3b82c4";
    case "sqlite":
      return "#0f9bdc";
    default:
      return "var(--accent)";
  }
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
  base: {
    pt: "1.5",
    pb: "0.5",
    pl: "2",
    pr: "2.5",
    fontSize: "2xs",
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "app.textMuted",
  },
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
  onCreate: () => void;
  onEdit: (profile: ConnectionProfile) => void;
  onDuplicate: (profile: ConnectionProfile) => void;
  onDelete: (id: string) => void;
  onPickTable: (database: string, table: string) => void;
  onImportTable: (database: string, table: string) => void;
  /** スキーマに基づくテストデータ生成ウィザードを開く (#602)。read_only では無効化。 */
  onGenerateTestData?: (database: string, table: string) => void;
  onDumpDatabase: (database: string) => void;
  /** DB スキーマを AI 向け Markdown としてエクスポートするモーダルを開く。 */
  onSchemaExport?: (database: string) => void;
  onRunTableSelect: (database: string, table: string) => void;
  onInsertTableSelect: (database: string, table: string) => void;
  /** Provided only for drivers with a single-statement definition (MySQL/SQLite). */
  onShowCreateTable?: (database: string, table: string) => void;
  /** DB ノードから新規テーブル作成ウィザードを開く。 */
  onCreateTable?: (database: string) => void;
  /** テーブル保守操作: TRUNCATE / DROP / RENAME。read_only では無効化される。 */
  onTruncateTable?: (database: string, table: string) => void;
  onDropTable?: (database: string, table: string) => void;
  onRenameTable?: (database: string, table: string) => void;
  /** テーブル保守コマンド (ANALYZE / OPTIMIZE / VACUUM / REINDEX 等)。#561。
   *  生成済み SQL を渡し、確認 + 実行は呼び出し側 (App) が担う。read_only では無効化。 */
  onRunTableMaintenance?: (database: string, table: string, command: MaintenanceCommand) => void;
  /** DB 全体の保守コマンド (SQLite VACUUM / PostgreSQL VACUUM・ANALYZE 等)。#561。 */
  onRunDatabaseMaintenance?: (database: string, command: MaintenanceCommand) => void;
  /** DB ノードからサイズ・統計ダッシュボードを開く。#562。 */
  onShowDatabaseSizes?: (database: string) => void;
  /** テーブル名をクリップボードへコピー。 */
  onCopyTableName?: (table: string) => void;
  /** スキーマオブジェクトの定義を開く。`id` は同名衝突を避ける一意識別子。 */
  onOpenObjectDefinition?: (database: string, kind: string, name: string, id: string | null) => void;
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

// React.memo + forwardRef でラップし、App.tsx の再レンダリング (クエリ入力や
// ストリーミングのたびに発生する) でツリー全体が無駄に再描画されるのを防ぐ。
// forwardRef は App.tsx から focusFilter() を呼ぶための ConnectionListHandle を
// 公開するために必要。親から渡るコールバックは App 側で useCallback 安定化済みの
// ため、接続状態が変わらない限り memo がスキップする。
export const ConnectionList = memo(forwardRef<ConnectionListHandle, Props>(function ConnectionList({
  profiles,
  activeProfileId,
  sessionId,
  connectingId,
  errorProfileId,
  openProfileIds,
  onConnect,
  onDisconnectProfile,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
  onPickTable,
  onImportTable,
  onGenerateTestData,
  onDumpDatabase,
  onSchemaExport,
  onRunTableSelect,
  onInsertTableSelect,
  onShowCreateTable,
  onCreateTable,
  onTruncateTable,
  onDropTable,
  onRenameTable,
  onRunTableMaintenance,
  onRunDatabaseMaintenance,
  onShowDatabaseSizes,
  onCopyTableName,
  onOpenObjectDefinition,
  selectLimit,
  favorites,
  recent,
  onToggleFavorite,
}, ref) {
  const t = useT();
  const [expandedProfiles, setExpandedProfiles] = useState<Record<string, boolean>>({});
  const [expandedDbs, setExpandedDbs] = useState<Record<string, boolean>>({});
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  // グループ折りたたみ状態は localStorage に永続化し、再起動後も維持する。
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(readCollapsedGroups);
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
  const [filter, setFilter] = useState("");
  const filterInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<{ col: TableColumnInfo; rect: DOMRect } | null>(
    null,
  );
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

      let dbs: string[];
      try {
        dbs = await api.listDatabases(targetSessionId);
      } catch (e) {
        if (sessionIdRef.current === targetSessionId) setError(String(e));
        return;
      }
      if (sessionIdRef.current !== targetSessionId) return;
      setDatabases(dbs);

      const existingOpenDbs = openDbNames.filter((db) => dbs.includes(db));

      // Fetch tables (+ estimates + non-table objects) for the open DBs.
      const nextTables: Record<string, string[]> = {};
      const nextEstimates: Record<string, Record<string, number | null>> = {};
      const nextObjects: Record<string, SchemaObject[]> = {};
      const failedTableDbs = new Set<string>();
      await Promise.all(
        existingOpenDbs.map(async (db) => {
          try {
            nextTables[db] = await api.listTables(targetSessionId, db);
          } catch {
            // Skip a database that failed to list; re-expanding retries it.
            failedTableDbs.add(db);
          }
          try {
            const est = await api.tableRowEstimates(targetSessionId, db);
            const map: Record<string, number | null> = {};
            for (const e of est) map[e.name] = e.estimate;
            nextEstimates[db] = map;
          } catch {
            // Estimates are decorative; a failure just drops the badges.
          }
          try {
            nextObjects[db] = await api.listSchemaObjects(targetSessionId, db);
          } catch {
            nextObjects[db] = [];
          }
        }),
      );
      if (sessionIdRef.current !== targetSessionId) return;

      // Fetch columns (+ indexes) only for open tables under an open DB that we
      // listed and confirmed still exist.
      const nextCols: Record<string, TableColumnInfo[]> = {};
      const nextIndexes: Record<string, IndexInfo[]> = {};
      await Promise.all(
        openTableKeys.map(async (key) => {
          const sep = key.indexOf("::");
          if (sep < 0) return;
          const db = key.slice(0, sep);
          const tbl = key.slice(sep + 2);
          if (!nextTables[db]?.includes(tbl)) return;
          try {
            nextCols[key] = await api.describeTable(targetSessionId, db, tbl);
          } catch {
            return;
          }
          try {
            nextIndexes[key] = await api.listIndexes(targetSessionId, db, tbl);
          } catch {
            nextIndexes[key] = [];
          }
        }),
      );
      if (sessionIdRef.current !== targetSessionId) return;

      setTables((prev) => ({ ...prev, ...nextTables }));
      setRowEstimates((prev) => ({ ...prev, ...nextEstimates }));
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
      const dbs = await api.listDatabases(targetSessionId);
      const openDbs = Object.keys(expandedDbs).filter(
        (db) => expandedDbs[db] && dbs.includes(db),
      );
      const nextTables: Record<string, string[]> = {};
      const nextEstimates: Record<string, Record<string, number | null>> = {};
      await Promise.all(
        openDbs.map(async (db) => {
          try {
            nextTables[db] = await api.listTables(targetSessionId, db);
          } catch {
            // Skip a database that failed to list; re-expanding retries it.
          }
          try {
            const est = await api.tableRowEstimates(targetSessionId, db);
            const map: Record<string, number | null> = {};
            for (const e of est) map[e.name] = e.estimate;
            nextEstimates[db] = map;
          } catch {
            // Estimates are decorative; a failure just drops the badges.
          }
        }),
      );
      const nextCols: Record<string, TableColumnInfo[]> = {};
      await Promise.all(
        Object.keys(expandedTables)
          .filter((key) => expandedTables[key])
          .map(async (key) => {
            const sep = key.indexOf("::");
            const db = key.slice(0, sep);
            const tbl = key.slice(sep + 2);
            if (!nextTables[db]?.includes(tbl)) return;
            try {
              nextCols[key] = await api.describeTable(targetSessionId, db, tbl);
            } catch {
              // Skip a table that failed; re-expanding retries it.
            }
          }),
      );
      // The session may have changed while we awaited — don't clobber the new
      // connection's tree with results fetched for the old one.
      if (sessionIdRef.current !== targetSessionId) return;
      tablesInFlightRef.current.clear();
      setDatabases(dbs);
      setTables(nextTables);
      setRowEstimates(nextEstimates);
      setTableColumns(nextCols);
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

  // The column tooltip is anchored to a snapshot of the row's position, so it
  // would detach if the tree scrolls or the window resizes under the pointer.
  useEffect(() => {
    if (!hoveredColumn) return;
    const clear = () => setHoveredColumn(null);
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, [hoveredColumn]);

  const handleProfileClick = (p: ConnectionProfile) => {
    if (p.id === activeProfileId) {
      setExpandedProfiles((prev) => ({ ...prev, [p.id]: !prev[p.id] }));
      return;
    }
    if (connectingId) return;
    onConnect(p);
  };

  const handleProfileContextMenu = (e: React.MouseEvent, p: ConnectionProfile) => {
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
        { label: t("contextMenuEdit"), onSelect: () => onEdit(p) },
        { label: t("contextMenuDuplicate"), onSelect: () => onDuplicate(p) },
        {
          label: t("contextMenuDelete"),
          danger: true,
          onSelect: () => {
            if (confirm(t("listDeleteConfirm", { name: p.name }))) onDelete(p.id);
          },
        },
      ],
    });
  };

  const handleTableContextMenu = (e: React.MouseEvent, db: string, tbl: string) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuEntry[] = [
      { label: t("contextMenuRunSelect", { limit: selectLimit }), onSelect: () => onRunTableSelect(db, tbl) },
      { label: t("contextMenuInsertSelect"), onSelect: () => onInsertTableSelect(db, tbl) },
    ];
    if (onShowCreateTable) {
      items.push({ label: t("contextMenuShowCreate"), onSelect: () => onShowCreateTable(db, tbl) });
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
    // テーブル保守操作: TRUNCATE / DROP / RENAME。破壊的なので read_only では
    // 無効化し、実行時は呼び出し側 (App) が確認ダイアログを挟む。
    if (onTruncateTable || onDropTable || onRenameTable) {
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
        for (const command of commands) {
          items.push({
            label: t(MAINTENANCE_LABEL_KEYS[command.kind]),
            onSelect: () => onRunTableMaintenance(db, tbl, command),
            disabled: activeReadOnly,
            title: roTitle,
          });
        }
      }
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const handleDbContextMenu = (e: React.MouseEvent, db: string) => {
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
    items.push({ label: t("contextMenuDump"), onSelect: () => onDumpDatabase(db) });
    if (onSchemaExport) {
      items.push({ label: t("contextMenuSchemaExport"), onSelect: () => onSchemaExport(db) });
    }
    if (onShowDatabaseSizes) {
      items.push({ label: t("sizeMenuLabel"), onSelect: () => onShowDatabaseSizes(db) });
    }
    // DB 全体の保守コマンド (#561)。SQLite/PostgreSQL のみ対象 (MySQL はグローバル
    // 保守文が無いため空)。データは消さないが書き込み/ロックを伴うため read_only で無効化。
    if (onRunDatabaseMaintenance) {
      const commands = databaseMaintenanceCommands(activeDriver);
      if (commands.length > 0) {
        const roTitle = activeReadOnly ? t("listReadOnlyTitle") : undefined;
        items.push({ separator: true });
        for (const command of commands) {
          items.push({
            label: t(MAINTENANCE_LABEL_KEYS[command.kind]),
            onSelect: () => onRunDatabaseMaintenance(db, command),
            disabled: activeReadOnly,
            title: roTitle,
          });
        }
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
      const list = await api.listTables(sessionId, db);
      setTables((prev) => ({ ...prev, [db]: list }));
      void loadRowEstimates(sessionId, db);
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
      const cols = await api.describeTable(sessionId, db, tbl);
      setTableColumns((prev) => ({ ...prev, [key]: cols }));
      // インデックス一覧はベストエフォート: 取得失敗 (権限など) でも列表示は維持する。
      try {
        const idx = await api.listIndexes(sessionId, db, tbl);
        setTableIndexes((prev) => ({ ...prev, [key]: idx }));
      } catch {
        setTableIndexes((prev) => ({ ...prev, [key]: [] }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      columnsInFlightRef.current.delete(key);
    }
  };

  const q = filter.trim().toLowerCase();
  const searching = q.length > 0;
  const activeExpanded = activeProfileId ? !!expandedProfiles[activeProfileId] : false;
  // The schema tree only shows the active connection, so its read-only flag
  // governs whether write-y table actions (Import CSV) are offered.
  const activeReadOnly = !!profiles.find((p) => p.id === activeProfileId)?.read_only;
  // 保守コマンドの SQL 方言はアクティブ接続のドライバで決まる (ツリーは
  // アクティブ接続のみを表示する)。
  const activeDriver = profiles.find((p) => p.id === activeProfileId)?.driver ?? "mysql";

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
  const columnNameMatches = useCallback(
    (db: string, tbl: string) => {
      const cols = tableColumns[tableKey(db, tbl)];
      return !!cols && cols.some((c) => c.name.toLowerCase().includes(q));
    },
    [tableColumns, q],
  );
  const tableNodeMatches = useCallback(
    (db: string, tbl: string) => tbl.toLowerCase().includes(q) || columnNameMatches(db, tbl),
    [q, columnNameMatches],
  );
  const dbNodeMatches = useCallback(
    (db: string) => {
      if (db.toLowerCase().includes(q)) return true;
      const tbls = tables[db];
      return !!tbls && tbls.some((tbl) => tableNodeMatches(db, tbl));
    },
    [q, tables, tableNodeMatches],
  );

  // The active connection's schema has a hit, so keep its profile visible even
  // when the query doesn't match the profile's own metadata.
  const activeSchemaMatches =
    searching && !!sessionId && databases !== null && databases.some(dbNodeMatches);

  // Eagerly load every database's table list while a schema search is active so
  // table-name matches surface without the user expanding each database first.
  // Gated on the active connection being expanded to avoid loading on a plain
  // profile-name filter. Columns stay lazy (loaded on table expand).
  useEffect(() => {
    if (!searching || !sessionId || databases === null || !activeExpanded) return;
    for (const db of databases) {
      if (tables[db] !== undefined || tablesInFlightRef.current.has(db)) continue;
      tablesInFlightRef.current.add(db);
      api
        .listTables(sessionId, db)
        .then((list) => setTables((prev) => ({ ...prev, [db]: list })))
        .catch(() => {})
        .finally(() => tablesInFlightRef.current.delete(db));
    }
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
    const names = Array.from(map.keys())
      .filter((k): k is string => k !== null)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) groups.push({ name, profiles: map.get(name)! });
    const ungrouped = map.get(null);
    if (ungrouped && ungrouped.length > 0) groups.push({ name: null, profiles: ungrouped });
    return groups;
  }, [profiles, visibleProfiles]);

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

  // スケルトン幅: 視覚的なランダム感を演出するために固定幅サイクルを使う。
  const SKELETON_ROW_WIDTHS = [72, 58, 85, 65, 78];

  const renderLoadingRow = () => (
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

  // クイックアクセス: アクティブ接続の databases の上に「お気に入り」「最近」を
  // 並べ、ワンクリックで開けるようにする。各行は db.table を表示し、`onPickTable` で開く。
  const renderQuickAccessRow = (refItem: TableRef, kind: "favorite" | "recent") => {
    const star = kind === "favorite";
    return (
      <TreeRow
        key={`${kind}:${tableKey(refItem.database, refItem.table)}`}
        pl="1"
        role="treeitem"
        onClick={() => onPickTable(refItem.database, refItem.table)}
        onContextMenu={(e) => handleTableContextMenu(e, refItem.database, refItem.table)}
        title={`${refItem.database}.${refItem.table}`}
        _hover={{ bg: "app.rowHover" }}
      >
        <TreeChevron aria-hidden style={{ visibility: "hidden" }}>▸</TreeChevron>
        <TreeIcon color={star ? "#eab308" : "app.textSecondary"} aria-hidden>
          <Icon name={star ? "star-filled" : "clock"} />
        </TreeIcon>
        <TreeLabel fontWeight={400}>
          {refItem.table}
          <chakra.span color="app.textMuted" fontSize="2xs" ml="1.5">
            {refItem.database}
          </chakra.span>
        </TreeLabel>
        {star && onToggleFavorite && (
          <chakra.button
            type="button"
            aria-label={t("quickAccessRemoveTitle")}
            title={t("quickAccessRemoveTitle")}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(refItem.database, refItem.table);
            }}
            color="app.textMuted"
            px="1"
            _hover={{ color: "app.text" }}
          >
            <Icon name="close" size={ICON_SIZES.sm} />
          </chakra.button>
        )}
      </TreeRow>
    );
  };

  // 非テーブルのスキーマオブジェクトを種別ごとにグループ化して描画する。
  // 選択すると onOpenObjectDefinition で定義 DDL を開く。
  const renderSchemaObjects = (db: string) => {
    if (!onOpenObjectDefinition) return null;
    const objs = schemaObjects[db];
    if (!objs || objs.length === 0) return null;
    const order: SchemaObject["kind"][] = [
      "view",
      "materialized_view",
      "procedure",
      "function",
      "trigger",
    ];
    const labels: Record<string, string> = {
      view: t("objGroupViews"),
      materialized_view: t("objGroupMatViews"),
      procedure: t("objGroupProcedures"),
      function: t("objGroupFunctions"),
      trigger: t("objGroupTriggers"),
    };
    const icons: Record<string, IconName> = {
      view: "view",
      materialized_view: "view",
      procedure: "routine",
      function: "routine",
      trigger: "trigger",
    };
    return (
      <>
        {order.map((kind) => {
          const items = objs.filter((o) => o.kind === kind);
          if (items.length === 0) return null;
          return (
            <div key={kind}>
              <QuickAccessHeader>{labels[kind] ?? kind}</QuickAccessHeader>
              {items.map((o) => (
                <TreeRow
                  key={`${kind}:${o.name}:${o.id ?? ""}`}
                  pl="1"
                  role="treeitem"
                  onClick={() => onOpenObjectDefinition(db, o.kind, o.name, o.id)}
                  title={`${o.name} — ${labels[kind] ?? kind}`}
                  _hover={{ bg: "app.rowHover" }}
                >
                  <TreeChevron visibility="hidden" aria-hidden />
                  <TreeIcon color="app.textSecondary" aria-hidden>
                    <Icon name={icons[kind] ?? "query"} />
                  </TreeIcon>
                  <TreeLabel fontWeight={400}>
                    <HighlightText text={o.name} query={q} />
                  </TreeLabel>
                </TreeRow>
              ))}
            </div>
          );
        })}
      </>
    );
  };

  const renderQuickAccess = () => {
    const favs = favorites ?? [];
    const recents = recent ?? [];
    if (favs.length === 0 && recents.length === 0) return null;
    return (
      <>
        {favs.length > 0 && (
          <>
            <QuickAccessHeader>{t("quickAccessFavorites")}</QuickAccessHeader>
            {favs.map((r) => renderQuickAccessRow(r, "favorite"))}
          </>
        )}
        {recents.length > 0 && (
          <>
            <QuickAccessHeader>{t("quickAccessRecent")}</QuickAccessHeader>
            {recents.map((r) => renderQuickAccessRow(r, "recent"))}
          </>
        )}
      </>
    );
  };

  const renderProfile = (p: ConnectionProfile) => {
    const isActive = p.id === activeProfileId;
    const isOpen = !!expandedProfiles[p.id];
    // When the query matches the connection's own metadata, show its full tree;
    // otherwise treat the query as a schema search and filter the tree to
    // matching databases / tables / columns.
    const schemaFiltered = searching && !profileMetaMatches(p);
    const status = profileStatus(p);
    const accent = normalizeChipColor(p.color) ?? undefined;
    const refreshing = refreshingSession === sessionId;
    // Left stripe + tint priority: production (red, always wins) > custom color >
    // active accent > none. A custom color also overrides the active accent
    // stripe, matching the previous inline-style behaviour.
    let borderLeftColor: string;
    let rowBg: string | undefined;
    if (p.is_production) {
      borderLeftColor = "var(--status-error)";
      rowBg = isActive
        ? "color-mix(in srgb, var(--status-error) 12%, var(--bg-active))"
        : "color-mix(in srgb, var(--status-error) 6%, transparent)";
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
      <MotionTreeNode key={p.id} {...variants.fade} transition={transitions.crossfade}>
        <MotionTreeRow
          pt="5px"
          pb="5px"
          pr="2.5"
          pl="5px"
          // プロファイルカラー / 本番 / アクティブを左端のアクセントバーで示す。
          // 識別性を上げるため 4px に。全行で同一幅 (色なしは transparent) にして
          // 行頭テキストの揃えを保つ。
          borderLeftWidth="4px"
          borderLeftColor={borderLeftColor}
          bg={rowBg}
          _hover={{ bg: rowBg ?? "app.hover" }}
          // ホバーで控えめに拡大 + 影を出すモーション。
          // prefers-reduced-motion はルートの MotionConfig が自動抑制する。
          whileHover={{ scale: 1.01, boxShadow: "var(--shadow-md)" }}
          transition={springs.gentle}
          style={{ transformOrigin: "center left" }}
          onClick={() => handleProfileClick(p)}
          onContextMenu={(e) => handleProfileContextMenu(e, p)}
          role="treeitem"
          aria-expanded={isOpen}
          title={
            p.driver === "sqlite"
              ? p.file_path ?? p.name
              : `${p.user}@${p.host}:${p.port}${p.database ? "/" + p.database : ""}${p.ssh ? " " + t("listVia", { host: p.ssh.host }) : ""}`
          }
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
            gap="1px"
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
              title={subtitle}
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
              title={t("treeRefreshTitle")}
              aria-label={t("treeRefresh")}
            >
              <chakra.span
                display="inline-flex"
                animation={refreshing ? "spinner-rotate var(--dur-spin) linear infinite" : undefined}
              >
                <Icon name="refresh" size={13} />
              </chakra.span>
            </chakra.button>
          )}
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
            title={statusLabel(status)}
          />
        </MotionTreeRow>

        <TreeCollapse open={!!(isOpen && isActive && sessionId)}>
          <TreeChildren>
            {isActive && sessionId && renderQuickAccess()}
            {databases === null ? (
              renderLoadingRow()
            ) : databases.length === 0 ? (
              <TreeEmpty>{t("treeNoDatabases")}</TreeEmpty>
            ) : (
              databases
                .filter((db) => !schemaFiltered || dbNodeMatches(db))
                .map((db) => {
                const dbNameHit = searching && db.toLowerCase().includes(q);
                const dbOpen = !!expandedDbs[db] || (schemaFiltered && dbNodeMatches(db));
                const dbTables = tables[db];
                return (
                  <TreeNode key={db}>
                    <TreeRow
                      pl="1"
                      onClick={() => toggleDb(db)}
                      onContextMenu={(e) => handleDbContextMenu(e, db)}
                      role="treeitem"
                      aria-expanded={dbOpen}
                      title={db}
                    >
                      <TreeChevron transform={dbOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
                      <TreeIcon color="#0ea5e9" aria-hidden><Icon name="database" /></TreeIcon>
                      <TreeLabel fontWeight={400}><HighlightText text={db} query={q} /></TreeLabel>
                    </TreeRow>
                    <TreeCollapse open={dbOpen}>
                      <TreeChildren>
                        {dbTables === undefined ? (
                          renderLoadingRow()
                        ) : dbTables.length === 0 ? (
                          <TreeEmpty>{t("treeNoTables")}</TreeEmpty>
                        ) : (
                          dbTables
                            .filter((tbl) => !schemaFiltered || dbNameHit || tableNodeMatches(db, tbl))
                            .map((tbl) => {
                            const tKey = tableKey(db, tbl);
                            const tableNameHit = searching && tbl.toLowerCase().includes(q);
                            const showAllCols = !schemaFiltered || dbNameHit || tableNameHit;
                            const tOpen =
                              !!expandedTables[tKey] || (schemaFiltered && columnNameMatches(db, tbl));
                            const cols = tableColumns[tKey];
                            const rowEst = rowEstimates[db]?.[tbl];
                            const rowEstLabel =
                              typeof rowEst === "number" ? formatRowEstimate(rowEst) : "";
                            return (
                              <TreeNode key={tbl}>
                                <TreeRow
                                  pl="1"
                                  role="treeitem"
                                  aria-expanded={tOpen}
                                  onClick={() => toggleTable(db, tbl)}
                                  onDoubleClick={() => onPickTable(db, tbl)}
                                  onContextMenu={(e) => handleTableContextMenu(e, db, tbl)}
                                  title={t("treeTableTitle")}
                                  _hover={{ bg: "app.rowHover" }}
                                >
                                  <TreeChevron transform={tOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
                                  <TreeIcon color="app.textSecondary" aria-hidden><Icon name="table" /></TreeIcon>
                                  <TreeLabel fontWeight={400}><HighlightText text={tbl} query={q} /></TreeLabel>
                                  {rowEstLabel && (
                                    <TreeBadge
                                      fontFamily="mono"
                                      fontSize="2xs"
                                      textTransform="none"
                                      letterSpacing="0"
                                      title={`${rowEst!.toLocaleString()} — ${t("treeRowEstimateTitle")}`}
                                    >
                                      {rowEstLabel}
                                    </TreeBadge>
                                  )}
                                </TreeRow>
                                <TreeCollapse open={tOpen}>
                                  <TreeChildren>
                                    {cols === undefined ? (
                                      renderLoadingRow()
                                    ) : cols.length === 0 ? (
                                      <TreeEmpty>{t("treeNoColumns")}</TreeEmpty>
                                    ) : (
                                      cols
                                        .filter((col) => showAllCols || col.name.toLowerCase().includes(q))
                                        .map((col) => {
                                        const isPk = col.key === "PRI";
                                        const isFk = col.referenced_table !== null;
                                        return (
                                          <TreeRow
                                            key={col.name}
                                            pt="3px"
                                            pb="3px"
                                            cursor="default"
                                            fontSize="sm"
                                            role="treeitem"
                                            onMouseEnter={(e) =>
                                              setHoveredColumn({
                                                col,
                                                rect: e.currentTarget.getBoundingClientRect(),
                                              })
                                            }
                                            onMouseLeave={() =>
                                              setHoveredColumn((cur) => (cur?.col === col ? null : cur))
                                            }
                                          >
                                            <TreeChevron visibility="hidden" aria-hidden />
                                            <TreeIcon
                                              fontSize="xs"
                                              color={isPk ? "app.keyAccent" : isFk ? "app.accent" : "app.textMuted"}
                                              title={isPk ? t("colPkTitle") : isFk ? t("colFkTitle") : undefined}
                                              aria-hidden
                                            >
                                              {isPk ? <Icon name="key" /> : isFk ? <Icon name="link" /> : "·"}
                                            </TreeIcon>
                                            <TreeLabel fontFamily="mono" color="app.text"><HighlightText text={col.name} query={q} /></TreeLabel>
                                            <TreeBadge
                                              fontFamily="mono"
                                              textTransform="lowercase"
                                              fontSize="2xs"
                                              title={col.data_type}
                                            >
                                              {col.data_type}
                                            </TreeBadge>
                                          </TreeRow>
                                        );
                                      })
                                    )}
                                    {/* インデックス一覧。展開時に列と並行取得し、
                                        列の下に小見出し付きで表示する。 */}
                                    {showAllCols && (tableIndexes[tKey]?.length ?? 0) > 0 && (
                                      <>
                                        <QuickAccessHeader>{t("indexesLabel")}</QuickAccessHeader>
                                        {tableIndexes[tKey].map((idx) => (
                                          <TreeRow
                                            key={`idx:${idx.name}`}
                                            pt="3px"
                                            pb="3px"
                                            cursor="default"
                                            fontSize="sm"
                                            role="treeitem"
                                            title={`${idx.name}${idx.method ? ` (${idx.method})` : ""}: ${idx.columns.join(", ")}`}
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
                                                title={idx.name}
                                              >
                                                {idx.primary ? t("indexBadgePk") : t("indexBadgeUnique")}
                                              </TreeBadge>
                                            )}
                                          </TreeRow>
                                        ))}
                                      </>
                                    )}
                                  </TreeChildren>
                                </TreeCollapse>
                              </TreeNode>
                            );
                          })
                        )}
                        {!schemaFiltered && renderSchemaObjects(db)}
                      </TreeChildren>
                    </TreeCollapse>
                  </TreeNode>
                );
              })
            )}
          </TreeChildren>
        </TreeCollapse>
      </MotionTreeNode>
    );
  };

  return (
    <Flex direction="column" overflow="hidden" flex="1">
      <Box px="2.5" py="2" borderBottom="1px solid" borderColor="app.borderSubtle">
        <Input
          ref={filterInputRef}
          type="search"
          py="5px"
          fontSize="sm"
          placeholder={t("listSearchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </Box>

      {error && (
        <Box
          px="3"
          py="1.5"
          fontSize="xs"
          color="app.textError"
          bg="app.bgError"
          borderBottom="1px solid"
          borderColor="app.borderSubtle"
        >
          {error}
        </Box>
      )}

      {profiles.length === 0 ? (
        <EmptyState
          illustration={<WelcomeIllustration />}
          icon="server"
          title={t("listEmptyTitle")}
          description={t("listEmptyDesc")}
          action={{ label: t("listCreateFirst"), onClick: onCreate }}
        />
      ) : visibleProfiles.length === 0 ? (
        <Text color="app.textMuted" p="3">{t("listNoMatches")}</Text>
      ) : (
        <Box flex="1" overflowY="auto" py="1" fontSize="md" color="app.text" role="tree">
          {grouped === null
            ? <AnimatePresence initial={false}>{visibleProfiles.map(renderProfile)}</AnimatePresence>
            : grouped.map((g) => {
                const key = g.name ?? "__ungrouped__";
                const groupOpen = expandedGroups[key] !== false;
                const label = g.name ?? t("listGroupUngrouped");
                return (
                  <TreeNode key={key}>
                    <Box
                      display="flex"
                      alignItems="center"
                      gap="1"
                      whiteSpace="nowrap"
                      overflow="hidden"
                      userSelect="none"
                      cursor="pointer"
                      pt="1.5"
                      pr="2.5"
                      pb="1.5"
                      pl="1.5"
                      fontSize="xs"
                      textTransform="uppercase"
                      letterSpacing="0.06em"
                      color="app.textMuted"
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
                      onClick={() =>
                        setExpandedGroups((prev) => ({ ...prev, [key]: prev[key] === false ? true : false }))
                      }
                      role="treeitem"
                      aria-expanded={groupOpen}
                    >
                      <TreeChevron transform={groupOpen ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
                      {/* グループ名のイニシャルアバター (#663)。未分類グループには
                          そもそも意味のあるイニシャルが無いので出さない。 */}
                      {g.name && <GroupAvatar name={g.name} size={16} />}
                      <chakra.span flex="1" fontWeight={600} overflow="hidden" textOverflow="ellipsis">
                        {label}
                      </chakra.span>
                      <TreeBadge textTransform="none" letterSpacing="0">{g.profiles.length}</TreeBadge>
                    </Box>
                    <TreeCollapse open={groupOpen}>
                      <Box display="flex" flexDirection="column">
                        <AnimatePresence initial={false}>
                          {g.profiles.map(renderProfile)}
                        </AnimatePresence>
                      </Box>
                    </TreeCollapse>
                  </TreeNode>
                );
              })}
        </Box>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {hoveredColumn && <ColumnTooltip col={hoveredColumn.col} anchor={hoveredColumn.rect} />}
    </Flex>
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
function ColumnTooltip({ col, anchor }: { col: TableColumnInfo; anchor: DOMRect }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    let left = anchor.right + margin;
    if (left + width + margin > window.innerWidth) {
      left = anchor.left - margin - width;
    }
    left = Math.max(margin, left);
    let top = anchor.top;
    if (top + height + margin > window.innerHeight) {
      top = window.innerHeight - margin - height;
    }
    top = Math.max(margin, top);
    setPos({ left, top });
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
      </chakra.dl>
    </Box>
  );
}
