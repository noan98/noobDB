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
  editorPreview: "Preview",
  editorPreviewTitle: "Dry-run the statement in a transaction and show before/after — changes are rolled back.",
  editorHintDisabled: "Connect a session to run queries.",
  editorHint: "Tip: select text to run only that fragment.",

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
  previewTruncated: "Snapshots truncated to {limit} rows.",

  treeNotConnected: "Not connected.",
  treeNoDatabases: "(no databases)",
  treeNoTables: "(no tables)",
  treeLoading: "Loading...",
  treeTableTitle: "Double-click to SELECT * LIMIT 100",
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
  editorPreview: "プレビュー",
  editorPreviewTitle: "トランザクション内で試し実行し、Before/After を表示します（変更はロールバック）。",
  editorHintDisabled: "クエリを実行するにはセッションに接続してください。",
  editorHint: "ヒント: テキストを選択するとその部分のみを実行できます。",

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
  previewTruncated: "スナップショットは {limit} 行に制限されています。",

  treeNotConnected: "接続されていません。",
  treeNoDatabases: "(データベースがありません)",
  treeNoTables: "(テーブルがありません)",
  treeLoading: "読み込み中...",
  treeTableTitle: "ダブルクリックで SELECT * LIMIT 100 を実行",
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
