import { useSyncExternalStore } from "react";

export type Locale = "en" | "ja";

const en = {
  appConnections: "Connections",
  appNew: "+ New",
  appDisconnect: "Disconnect",
  appDisconnected: "Disconnected",
  appTabQuery: "Query",
  appTabSchema: "Schema",
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

  listEmpty: "No saved connections yet.",
  listDbPasswordPlaceholder: "DB password (blank = use saved)",
  listSshPassphrasePlaceholder: "SSH passphrase (blank = use saved)",
  listConnect: "Connect",
  listEdit: "Edit",
  listDelete: "Delete",
  listDeleteConfirm: 'Delete "{name}"?',
  listVia: "via SSH {host}",

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
  editorHintDisabled: "Connect a session to run queries.",
  editorHint: "Tip: select text to run only that fragment.",

  resultEmpty: "No results yet. Run a query above.",
  resultExecuted: "Statement executed. {rows} rows affected ({ms} ms).",
  resultNull: "NULL",

  treeNotConnected: "Not connected.",
  treeNoDatabases: "(no databases)",
  treeTableTitle: "Double-click to SELECT * LIMIT 100",
};

type Key = keyof typeof en;
type Dict = Record<Key, string>;

const ja: Dict = {
  appConnections: "接続先",
  appNew: "＋ 新規",
  appDisconnect: "切断",
  appDisconnected: "未接続",
  appTabQuery: "クエリ",
  appTabSchema: "スキーマ",
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

  listEmpty: "保存された接続はまだありません。",
  listDbPasswordPlaceholder: "DBパスワード (空欄で保存済みを使用)",
  listSshPassphrasePlaceholder: "SSHパスフレーズ (空欄で保存済みを使用)",
  listConnect: "接続",
  listEdit: "編集",
  listDelete: "削除",
  listDeleteConfirm: "「{name}」を削除しますか？",
  listVia: "SSH {host} 経由",

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
  editorHintDisabled: "クエリを実行するにはセッションに接続してください。",
  editorHint: "ヒント: テキストを選択するとその部分のみを実行できます。",

  resultEmpty: "まだ結果はありません。上のエディタでクエリを実行してください。",
  resultExecuted: "ステートメントを実行しました。影響行数 {rows} 件 ({ms} ms)。",
  resultNull: "NULL",

  treeNotConnected: "接続されていません。",
  treeNoDatabases: "(データベースがありません)",
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
