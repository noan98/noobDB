/**
 * App Shell (#1112 / Epic #1110 Phase 2) の操作をコマンドパレットへ出す候補の組み立て。
 *
 * Sidebar (Database Explorer)・Bottom Panel・テーブル構造への導線は、ツールメニュー /
 * 右クリックメニュー / ショートカットだけでなくパレットからも同じ操作で辿れるように
 * する (Issue の UX 方針「Command Palette / Context Menu との連携を前提とする」)。
 *
 * 候補の可用条件 (未接続・SQLite 非対応・対象 DB 無し) をここへ集め、`App.tsx` は
 * 文脈と実行ハンドラを渡すだけにする。`App.tsx` の巨大な `useMemo` にこれ以上
 * 分岐を積まないためでもある。副作用なし (実行は渡された関数が担う)。
 */

import type { I18nKey } from "../i18n";
import type { BottomPanelTab } from "./bottomPanelTabs";
import type { CommandItem } from "./commandPaletteSearch";

export interface WorkspaceCommandContext {
  sessionId: string | null;
  /** アクティブ接続のドライバ。未接続なら null。 */
  driver: string | null;
  /** パレットの「現在の DB」(アクティブタブ → プロファイル既定)。 */
  database: string | null;
  /** 開いている接続の本数 (アクティブ + 背景)。 */
  openConnectionCount: number;
  /** サイドバーが今折りたたまれているか (ラベルの出し分け用)。 */
  sidebarCollapsed: boolean;
  /** スキーマキャッシュ済みのテーブル (アクティブ接続のもの)。 */
  tables: readonly { database: string; table: string }[];
  /** 表示用に解決済みのショートカット (`formatCombo` の戻り値)。 */
  shortcuts: { toggleSidebar?: string; sidebarFilter?: string };
}

export interface WorkspaceCommandActions {
  toggleBottomPanel: (tab: BottomPanelTab) => void;
  toggleSidebar: () => void;
  focusExplorer: () => void;
  openStructure: (database: string, table: string) => void;
}

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

/** プロセス一覧 / クエリインスペクタはサーバ統計を持たない SQLite では出さない。 */
const NO_SERVER_STATS = new Set(["sqlite"]);

export function workspaceCommandItems(
  ctx: WorkspaceCommandContext,
  actions: WorkspaceCommandActions,
  t: Translate,
): CommandItem[] {
  const items: CommandItem[] = [];

  // --- Sidebar (Database Explorer) ---
  items.push({
    id: "nav:toggle-sidebar",
    group: "navigation",
    label: ctx.sidebarCollapsed ? t("sidebarExpand") : t("sidebarCollapse"),
    icon: ctx.sidebarCollapsed ? "chevron-right" : "chevron-left",
    keywords: "sidebar explorer toggle collapse expand サイドバー 開閉 折りたたみ エクスプローラ",
    shortcut: ctx.shortcuts.toggleSidebar,
    run: () => actions.toggleSidebar(),
  });
  items.push({
    id: "nav:focus-explorer",
    group: "navigation",
    label: t("cmdkFocusExplorer"),
    icon: "filter",
    keywords: "explorer filter tree search table サイドバー ツリー 絞り込み テーブル 検索",
    shortcut: ctx.shortcuts.sidebarFilter,
    run: () => actions.focusExplorer(),
  });

  // --- Bottom Panel ---
  // ログ系 (#1114) は接続に依存しないので常に出す。
  items.push({
    id: "nav:output",
    group: "navigation",
    label: t("cmdkOutput"),
    icon: "query",
    keywords: "output log executed statements rows affected errors 出力 実行ログ 実行結果 影響行数 エラー",
    run: () => actions.toggleBottomPanel("output"),
  });
  items.push({
    id: "nav:messages",
    group: "navigation",
    label: t("cmdkMessages"),
    icon: "list",
    keywords: "messages status bar history errors メッセージ ステータス 履歴 エラー",
    run: () => actions.toggleBottomPanel("messages"),
  });
  items.push({
    id: "nav:activityPanel",
    group: "navigation",
    label: t("cmdkActivityPanel"),
    icon: "bell",
    keywords: "activity notifications toast panel アクティビティ 通知 トースト パネル",
    run: () => actions.toggleBottomPanel("activity"),
  });
  // アドバイザは DB コンテキストが要る (ツールメニューと同じガード)。DB が解決
  // できないと database="" で診断が失敗するため導線ごと出さない。
  if (ctx.sessionId && ctx.database) {
    items.push({
      id: "nav:advisor",
      group: "navigation",
      label: t("appAdvisor"),
      icon: "warning",
      keywords: "advisor schema health index lint 健全性 診断 インデックス",
      run: () => actions.toggleBottomPanel("advisor"),
    });
  }
  if (ctx.sessionId && !NO_SERVER_STATS.has(ctx.driver ?? "")) {
    items.push({
      id: "nav:inspector",
      group: "navigation",
      label: t("appQueryInspector"),
      icon: "explain",
      keywords: "inspector live query running statistics 実行中 クエリ 監視 統計",
      run: () => actions.toggleBottomPanel("inspector"),
    });
    items.push({
      id: "nav:processes",
      group: "navigation",
      label: t("appProcesses"),
      icon: "server",
      keywords: "process list kill session プロセス 一覧 セッション",
      run: () => actions.toggleBottomPanel("processes"),
    });
  }
  // データ品質アサーション (#742)。接続だけを要求する (検証 DB はセッション既定で可)。
  if (ctx.sessionId) {
    items.push({
      id: "nav:assertions",
      group: "navigation",
      label: t("cmdkAssertions"),
      icon: "check",
      keywords: "data quality assertion test not null unique accepted values range orphan row count データ品質 アサーション 検証 孤児 一意",
      run: () => actions.toggleBottomPanel("assertions"),
    });
  }
  if (ctx.openConnectionCount > 0) {
    items.push({
      id: "nav:connectionHealth",
      group: "navigation",
      label: t("healthTitle"),
      icon: "server",
      keywords: "health ping latency version status ヘルス 稼働 レイテンシ バージョン 死活",
      run: () => actions.toggleBottomPanel("health"),
    });
  }
  // 影響分析 (#1027)。対象はパネル内のフォームで決めるので接続だけを要求する。
  if (ctx.sessionId) {
    items.push({
      id: "nav:whereUsed",
      group: "navigation",
      label: t("cmdkWhereUsed"),
      icon: "search",
      keywords: "where used usages impact dependency references drop rename 影響分析 参照元 依存 使用箇所",
      run: () => actions.toggleBottomPanel("whereUsed"),
    });
  }

  // --- テーブル構造 (Data と並ぶ Structure への導線) ---
  if (ctx.sessionId) {
    for (const { database, table } of ctx.tables) {
      items.push({
        id: `structure:${database}\0${table}`,
        group: "tables",
        label: t("cmdkTableStructure", { table }),
        sublabel: database,
        keywords: `${table} ${database} structure columns indexes foreign keys 構造 列 インデックス 外部キー`,
        icon: "columns",
        run: () => actions.openStructure(database, table),
      });
    }
  }

  return items;
}
