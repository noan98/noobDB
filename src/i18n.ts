import { useSyncExternalStore } from "react";

export type Locale = "en" | "ja";

const en = {
  appConnections: "Connections",
  appNew: "New connection",
  appDisconnect: "Disconnect",
  appDisconnected: "Disconnected",
  appLanguage: "Language",
  appThemeToLight: "Switch to light theme",
  appThemeToDark: "Switch to dark theme",
  appThemeToggle: "Toggle theme",
  appSettings: "Settings",

  settingsTitle: "Settings",
  settingsLanguage: "Language",
  settingsLanguageHelp: "Choose the display language for the app.",
  settingsSyntaxHighlighting: "Syntax highlighting",
  settingsSyntaxHelp: "Editing colors for the {theme} theme.",
  settingsThemeLight: "light",
  settingsThemeDark: "dark",
  settingsColorKeyword: "Keyword",
  settingsColorKeywordSample: "SELECT, FROM, WHERE",
  settingsColorString: "String",
  settingsColorStringSample: "'hello'",
  settingsColorNumber: "Number",
  settingsColorNumberSample: "42, 3.14",
  settingsColorComment: "Comment",
  settingsColorCommentSample: "-- a comment",
  settingsColorFunction: "Function",
  settingsColorFunctionSample: "COUNT, MAX",
  settingsColorOperator: "Operator",
  settingsColorOperatorSample: "=, +, <",
  settingsReset: "Reset to defaults",
  settingsClose: "Close",
  settingsStreaming: "Record streaming",
  settingsStreamingHelp: "Controls how the records panel and the preview before/after panels load rows.",
  settingsDefaultDisplayCount: "Default display count",
  settingsDefaultDisplayCountHelp: "Number of rows shown immediately. Also used as the LIMIT when opening a table.",
  settingsStreamPrefetchSize: "Stream prefetch size",
  settingsStreamPrefetchSizeHelp: "Chunk size used when fetching additional rows after the initial batch.",
  settingsSafety: "Safety",
  settingsConfirmProductionConnect: "Confirm before connecting to production",
  settingsConfirmProductionConnectHelp: "Show a confirmation dialog when connecting to a profile marked as production.",
  productionConfirm: "「{name}」は本番環境としてマークされています。本当に接続しますか？",
  contextMenuEdit: "Edit connection",
  contextMenuDelete: "Delete connection",
  listProduction: "PROD",
  listGroupUngrouped: "(Ungrouped)",
  formGroup: "Group (optional)",
  formGroupPlaceholder: "e.g. Production, Staging, Development",
  formGroupHelp: "Connections with the same group name are bundled under one collapsible heading in the sidebar.",
  formDisplay: "Display (optional)",
  formColor: "Highlight color (optional)",
  formColorClear: "Clear",
  formIsProduction: "Mark as production",
  formIsProductionHelp: "Production-flagged profiles can show a confirmation dialog before connect (controlled in Settings).",

  statusStreaming: "Streaming... {rows} rows loaded ({ms} ms)",
  statusStreamingDone: "{rows} rows in {ms} ms",
  statusPreviewStreaming: "Streaming preview... ({ms} ms)",

  statusFailedLoadProfiles: "Failed to load profiles: {error}",
  statusConnecting: "Connecting to {name}...",
  statusConnected: "Connected to {name} (session {id})",
  statusConnectionFailed: "Connection failed: {error}",
  statusNotConnected: "Not connected",
  statusRunningQuery: "Running query...",
  statusRowsIn: "{rows} rows in {ms} ms",
  statusRowsAffected: "{rows} rows affected ({ms} ms)",
  statusQueryError: "Query error: {error}",
  statusRunningPreview: "Running preview (will roll back)...",
  statusPreviewDone: "Preview: {rows} rows affected ({ms} ms) — rolled back, DB unchanged",
  statusPreviewError: "Preview error: {error}",

  listEmpty: "No saved connections yet.",
  listNoMatches: "No connections match the filter.",
  listSearchPlaceholder: "Filter connections...",
  listDbPasswordPlaceholder: "DB password (blank = use saved)",
  listSshPassphrasePlaceholder: "SSH passphrase (blank = use saved)",
  listConnect: "Connect",
  listConnecting: "Connecting...",
  listEdit: "Edit",
  listEditConnection: "Edit connection...",
  listEditTitle: "Edit connection settings (host, port, credentials, SSH)",
  listDelete: "Delete",
  listDeleteConfirm: 'Delete "{name}"?',
  listVia: "via SSH {host}",

  statusBadge_connected: "Connected",
  statusBadge_connecting: "Connecting...",
  statusBadge_error: "Connection error",
  statusBadge_idle: "Disconnected",

  formPickKeyTitle: "Select SSH private key",
  formConnectionOk: "Connection OK.",
  formEditTitle: 'Edit "{name}"',
  formNewTitle: "New Connection",
  formName: "Name",
  formNamePlaceholder: "My DB",
  formMysqlLegend: "MySQL",
  formHost: "Host",
  formPort: "Port",
  formUser: "User",
  formDatabase: "Database (optional)",
  formDbPassword: "Password (saved to OS keyring; leave blank to keep existing)",
  formUseSsh: "Use SSH tunnel",
  formSshHost: "SSH Host",
  formSshUser: "SSH User",
  formPrivateKeyPath: "Private key path",
  formBrowse: "Browse...",
  formSshPassphrase: "Key passphrase (saved to keyring; leave blank to keep existing)",
  formCancel: "Cancel",
  formTest: "Test",
  formTesting: "Testing...",
  formSave: "Save",

  editorRun: "Run (selection or all)",
  editorRunOnTable: "Run ({table})",
  editorRunOnTableTitle: "Runs against `{database}` — selection or whole editor",
  editorPreview: "Preview",
  editorPreviewTitle: "Dry-run the statement in a transaction and show before/after — changes are rolled back.",
  editorBuilder: "Query Builder",
  editorBuilderTitle: "Build a SELECT/INSERT/UPDATE/DELETE statement from a guided form.",
  editorHintDisabled: "Connect a session to run queries.",

  qbTitle: "Query Builder",
  qbClose: "Close",
  qbQueryType: "Query type",
  qbDatabase: "Database",
  qbTable: "Table",
  qbColumns: "Columns",
  qbAllColumns: "All columns (*)",
  qbPickTableFirst: "Pick a table to choose columns.",
  qbWhere: "WHERE",
  qbAddCondition: "Add condition",
  qbColumn: "column",
  qbValue: "value",
  qbValuesPlaceholder: "comma-separated values",
  qbLimit: "LIMIT",
  qbSet: "SET",
  qbAddSet: "Add field",
  qbInsertValues: "Columns and values",
  qbAddValue: "Add field",
  qbPreview: "Query preview",
  qbCopy: "Copy",
  qbCopied: "Copied",
  qbExecute: "Execute",
  qbPreviewRun: "Preview run",
  qbRemove: "Remove",
  qbLoading: "Loading...",

  resultEmpty: "No results yet. Run a query above.",
  resultExecuted: "Statement executed. {rows} rows affected ({ms} ms).",
  resultNull: "NULL",

  previewBanner: "Preview — changes were rolled back. The database is unchanged.",
  previewTargetTable: "Target table: {table}",
  previewNoTarget: "Could not auto-detect the target table — showing affected row count only.",
  previewRowsAffected: "{rows} rows affected ({ms} ms)",
  previewBefore: "Before",
  previewAfter: "After",
  previewEmptyBefore: "(table was empty)",
  previewEmptyAfter: "(table is empty after the statement)",
  previewNoAffectedBefore: "(no affected rows on this side)",
  previewNoAffectedAfter: "(no affected rows on this side)",
  previewAffectedOutsideSnapshot: "Affected rows are outside the first {limit}-row snapshot.",
  previewSyncScroll: "Sync scroll",
  previewSyncScrollTitle: "Sync vertical and horizontal scroll between the before and after panes.",

  treeNotConnected: "Not connected.",
  treeNoDatabases: "(no databases)",
  treeNoTables: "(no tables)",
  treeNoColumns: "(no columns)",
  treeLoading: "Loading...",
  treeTableTitle: "Click to expand columns, double-click to SELECT * LIMIT 100",

  tabNew: "New query tab",
  tabClose: "Close tab",
  tabUntitledQuery: "Query",
  tabsEmpty: "No tabs open. Double-click a table or click + to start a query.",

  gridFilterPlaceholder: "Filter...",
  gridFilterAria: "Filter {column}",
  gridSortAsc: "Sort ascending",
  gridSortDesc: "Sort descending",
  gridSortClear: "Clear sort",
  gridFilteredCount: "Showing {shown} of {total} rows",
  gridClearFilters: "Clear filters",
  gridNoMatches: "No rows match the current filters.",
  gridResizeColumn: "Drag to resize; double-click to reset",

  splitterEditorAria: "Drag to resize editor and result area; double-click to reset",
  splitterPreviewAria: "Drag to resize before and after panes; double-click to reset",
};

type Key = keyof typeof en;
type Dict = Record<Key, string>;

const ja: Dict = {
  appConnections: "接続",
  appNew: "新規接続",
  appDisconnect: "切断",
  appDisconnected: "未接続",
  appLanguage: "言語",
  appThemeToLight: "ライトテーマに切替",
  appThemeToDark: "ダークテーマに切替",
  appThemeToggle: "テーマを切替",
  appSettings: "設定",

  settingsTitle: "設定",
  settingsLanguage: "言語",
  settingsLanguageHelp: "アプリの表示言語を選択します。",
  settingsSyntaxHighlighting: "シンタックスハイライト",
  settingsSyntaxHelp: "{theme}テーマの色を編集しています。",
  settingsThemeLight: "ライト",
  settingsThemeDark: "ダーク",
  settingsColorKeyword: "キーワード",
  settingsColorKeywordSample: "SELECT, FROM, WHERE",
  settingsColorString: "文字列",
  settingsColorStringSample: "'hello'",
  settingsColorNumber: "数値",
  settingsColorNumberSample: "42, 3.14",
  settingsColorComment: "コメント",
  settingsColorCommentSample: "-- コメント",
  settingsColorFunction: "関数",
  settingsColorFunctionSample: "COUNT, MAX",
  settingsColorOperator: "演算子",
  settingsColorOperatorSample: "=, +, <",
  settingsReset: "既定値に戻す",
  settingsClose: "閉じる",
  settingsStreaming: "レコードのストリーミング",
  settingsStreamingHelp: "レコードのパネルとプレビューの実行前後パネルでの読み込み方法を制御します。",
  settingsDefaultDisplayCount: "デフォルトの表示件数",
  settingsDefaultDisplayCountHelp: "初期表示する行数。テーブルを開くときの LIMIT としても使用されます。",
  settingsStreamPrefetchSize: "ストリーム読み込み時の事前取得件数",
  settingsStreamPrefetchSizeHelp: "初期分を表示した後、追加で取得する行数のチャンクサイズです。",
  settingsSafety: "セーフティ",
  settingsConfirmProductionConnect: "本番環境接続時に確認ダイアログを表示",
  settingsConfirmProductionConnectHelp: "本番環境としてマークされた接続先に接続する前に確認ダイアログを表示します。",
  productionConfirm: "「{name}」は本番環境としてマークされています。本当に接続しますか？",
  contextMenuEdit: "接続情報を編集",
  contextMenuDelete: "接続先を削除",
  listProduction: "本番",
  listGroupUngrouped: "(未分類)",
  formGroup: "グループ (任意)",
  formGroupPlaceholder: "例: Production, Staging, Development",
  formGroupHelp: "同じグループ名を指定した接続先は、サイドバーで折りたたみ可能な 1 つの見出しの下にまとまります。",
  formDisplay: "表示設定 (任意)",
  formColor: "ハイライト色 (任意)",
  formColorClear: "クリア",
  formIsProduction: "本番環境としてマーク",
  formIsProductionHelp: "本番マークされた接続先は、接続前に確認ダイアログを表示できます（設定で制御）。",

  statusStreaming: "ストリーミング中... {rows} 件取得 ({ms} ms)",
  statusStreamingDone: "{rows} 件取得 ({ms} ms)",
  statusPreviewStreaming: "プレビューをストリーミング中... ({ms} ms)",

  statusFailedLoadProfiles: "接続プロファイルの読み込みに失敗しました: {error}",
  statusConnecting: "{name} に接続中...",
  statusConnected: "{name} に接続しました (セッション {id})",
  statusConnectionFailed: "接続に失敗しました: {error}",
  statusNotConnected: "接続されていません",
  statusRunningQuery: "クエリを実行中...",
  statusRowsIn: "{rows} 件取得 ({ms} ms)",
  statusRowsAffected: "影響行数 {rows} 件 ({ms} ms)",
  statusQueryError: "クエリエラー: {error}",
  statusRunningPreview: "プレビュー実行中 (ロールバックされます)...",
  statusPreviewDone: "プレビュー: 影響行数 {rows} 件 ({ms} ms) — ロールバック済み、DBは変更されていません",
  statusPreviewError: "プレビューエラー: {error}",

  listEmpty: "保存された接続はまだありません。",
  listNoMatches: "条件に一致する接続がありません。",
  listSearchPlaceholder: "接続またはデータベースを検索",
  listDbPasswordPlaceholder: "DBパスワード (空欄で保存済みを使用)",
  listSshPassphrasePlaceholder: "SSHパスフレーズ (空欄で保存済みを使用)",
  listConnect: "接続",
  listConnecting: "接続中...",
  listEdit: "編集",
  listEditConnection: "接続情報を編集...",
  listEditTitle: "接続情報を編集 (ホスト・ポート・認証情報・SSH)",
  listDelete: "削除",
  listDeleteConfirm: "「{name}」を削除しますか？",
  listVia: "SSH {host} 経由",

  statusBadge_connected: "接続中",
  statusBadge_connecting: "接続処理中...",
  statusBadge_error: "接続エラー",
  statusBadge_idle: "未接続",

  formPickKeyTitle: "SSH秘密鍵を選択",
  formConnectionOk: "接続に成功しました。",
  formEditTitle: "「{name}」を編集",
  formNewTitle: "新規接続",
  formName: "名前",
  formNamePlaceholder: "例: My DB",
  formMysqlLegend: "MySQL",
  formHost: "ホスト",
  formPort: "ポート",
  formUser: "ユーザー",
  formDatabase: "データベース (任意)",
  formDbPassword: "パスワード (OSキーリングに保存。空欄で既存を維持)",
  formUseSsh: "SSHトンネルを使用",
  formSshHost: "SSHホスト",
  formSshUser: "SSHユーザー",
  formPrivateKeyPath: "秘密鍵のパス",
  formBrowse: "参照...",
  formSshPassphrase: "鍵パスフレーズ (キーリングに保存。空欄で既存を維持)",
  formCancel: "キャンセル",
  formTest: "テスト",
  formTesting: "テスト中...",
  formSave: "保存",

  editorRun: "実行 (選択範囲または全体)",
  editorRunOnTable: "実行 ({table})",
  editorRunOnTableTitle: "`{database}` を使用して実行（選択範囲またはエディタ全体）",
  editorPreview: "プレビュー",
  editorPreviewTitle: "トランザクション内で試し実行し、Before/After を表示します（変更はロールバック）。",
  editorBuilder: "クエリ組み立て",
  editorBuilderTitle: "フォームから SELECT/INSERT/UPDATE/DELETE 文を組み立てます。",
  editorHintDisabled: "クエリを実行するにはセッションに接続してください。",

  qbTitle: "クエリ組み立て",
  qbClose: "閉じる",
  qbQueryType: "クエリの種類",
  qbDatabase: "データベース",
  qbTable: "テーブル",
  qbColumns: "カラム",
  qbAllColumns: "全てのカラム (*)",
  qbPickTableFirst: "テーブルを選択するとカラムを選べます。",
  qbWhere: "WHERE",
  qbAddCondition: "条件を追加",
  qbColumn: "カラム",
  qbValue: "値",
  qbValuesPlaceholder: "カンマ区切りの値",
  qbLimit: "LIMIT",
  qbSet: "SET",
  qbAddSet: "項目を追加",
  qbInsertValues: "カラムと値",
  qbAddValue: "項目を追加",
  qbPreview: "クエリプレビュー",
  qbCopy: "コピー",
  qbCopied: "コピー済み",
  qbExecute: "実行",
  qbPreviewRun: "プレビュー実行",
  qbRemove: "削除",
  qbLoading: "読み込み中...",

  resultEmpty: "まだ結果はありません。上のエディタでクエリを実行してください。",
  resultExecuted: "ステートメントを実行しました。影響行数 {rows} 件 ({ms} ms)。",
  resultNull: "NULL",

  previewBanner: "プレビュー — 変更はロールバックされました。データベースは変更されていません。",
  previewTargetTable: "対象テーブル: {table}",
  previewNoTarget: "対象テーブルを自動検出できませんでした — 影響行数のみ表示しています。",
  previewRowsAffected: "影響行数 {rows} 件 ({ms} ms)",
  previewBefore: "実行前",
  previewAfter: "実行後",
  previewEmptyBefore: "(テーブルは空でした)",
  previewEmptyAfter: "(実行後、テーブルは空です)",
  previewNoAffectedBefore: "(影響のあるレコードはありません)",
  previewNoAffectedAfter: "(影響のあるレコードはありません)",
  previewAffectedOutsideSnapshot: "影響のあるレコードは先頭 {limit} 件のスナップショット範囲外です。",
  previewSyncScroll: "スクロールを同期",
  previewSyncScrollTitle: "実行前後のペインで縦・横のスクロールを同期します。",

  treeNotConnected: "接続されていません。",
  treeNoDatabases: "(データベースがありません)",
  treeNoTables: "(テーブルがありません)",
  treeNoColumns: "(カラムがありません)",
  treeLoading: "読み込み中...",
  treeTableTitle: "クリックでカラム展開、ダブルクリックで SELECT * LIMIT 100",

  tabNew: "新しいクエリタブ",
  tabClose: "タブを閉じる",
  tabUntitledQuery: "クエリ",
  tabsEmpty: "開いているタブがありません。テーブルをダブルクリックするか、+ を押してクエリを始めてください。",

  gridFilterPlaceholder: "絞り込み...",
  gridFilterAria: "{column} を絞り込む",
  gridSortAsc: "昇順で並び替え",
  gridSortDesc: "降順で並び替え",
  gridSortClear: "並び替えを解除",
  gridFilteredCount: "{total} 件中 {shown} 件を表示",
  gridClearFilters: "フィルターをクリア",
  gridNoMatches: "条件に一致する行がありません。",
  gridResizeColumn: "ドラッグでサイズ変更、ダブルクリックでリセット",

  splitterEditorAria: "ドラッグでエディタと結果領域のサイズを変更、ダブルクリックでリセット",
  splitterPreviewAria: "ドラッグで実行前・実行後ペインの幅を変更、ダブルクリックでリセット",
};

const dicts: Record<Locale, Dict> = { en, ja };

const STORAGE_KEY = "tablex.locale";

function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "ja") return stored;
  } catch {
    // ignore
  }
  const langs =
    typeof navigator !== "undefined"
      ? navigator.languages?.length
        ? navigator.languages
        : [navigator.language]
      : [];
  for (const l of langs) {
    const lc = l.toLowerCase();
    if (lc.startsWith("ja")) return "ja";
    if (lc.startsWith("en")) return "en";
  }
  return "en";
}

let current: Locale = detectInitial();
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

export function setLocale(loc: Locale): void {
  if (loc === current) return;
  current = loc;
  try {
    localStorage.setItem(STORAGE_KEY, loc);
  } catch {
    // ignore
  }
  try {
    document.documentElement.lang = loc;
  } catch {
    // ignore
  }
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  const dict = dicts[current];
  let s = dict[key] ?? en[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

export function useT(): typeof t {
  useLocale();
  return t;
}

try {
  document.documentElement.lang = current;
} catch {
  // ignore
}
