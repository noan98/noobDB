/**
 * `.sql` スクリプトの明示的な「開く」/「名前を付けて保存」導線 (#918) が使う純粋
 * ヘルパー。ドラッグ&ドロップ (`App.tsx` の `handleFilesDropped`) と読み込みロジック
 * (`api.readSqlFile`、文字コードの自動判定 / 手動指定つき、#1535) をそのまま共有する。
 * ここに置くのは、保存ダイアログの既定ファイル名の組み立てと文字コード選択肢の定義で、
 * App.tsx から切り離してユニットテストする。
 */

import type { TextEncodingId } from "./api/tauri";

/**
 * SQL ファイルの文字コード選択肢 (#1535)。日本語環境では Shift_JIS / EUC-JP のダンプや
 * UTF-16 保存の SQL が流通するため、開く・保存・スクリプト実行で共通に選べるようにする。
 * ラベルは固有名詞なので i18n しない。`utf-8-bom` / `utf-16*` は保存時に BOM を付ける。
 */
export const TEXT_ENCODING_OPTIONS: { id: TextEncodingId; label: string }[] = [
  { id: "utf-8", label: "UTF-8" },
  { id: "utf-8-bom", label: "UTF-8 (BOM)" },
  { id: "shift_jis", label: "Shift_JIS" },
  { id: "euc-jp", label: "EUC-JP" },
  { id: "utf-16le", label: "UTF-16LE" },
  { id: "utf-16be", label: "UTF-16BE" },
];

/** 文字コード識別子の表示名。未知の値はそのまま返す。 */
export function textEncodingLabel(id: TextEncodingId): string {
  return TEXT_ENCODING_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** `<select>` の値 (文字列) を文字コード識別子へ。空文字 (自動判定) と未知の値は `null`。 */
export function parseTextEncodingId(value: string): TextEncodingId | null {
  return TEXT_ENCODING_OPTIONS.find((o) => o.id === value)?.id ?? null;
}

/**
 * タブのタイトルから「名前を付けて保存」ダイアログの既定ファイル名を組み立てる。
 * ドラッグ&ドロップ / 「SQL ファイルを開く」で開いたタブは、タイトルが元のファイル名
 * (拡張子込み。`fileBaseName` 由来) そのものなので、既に `.sql` / `.txt` で終わって
 * いればそのまま使う。それ以外 (新規タブの既定タイトルなど) は `.sql` を補う。
 * パス区切り文字はファイル名として不正なため保険で `_` に置換し、空/空白のみの
 * タイトルは `query.sql` にフォールバックする。
 */
export function sqlSaveFileName(title: string): string {
  const trimmed = title.trim();
  const base = trimmed.length > 0 ? trimmed : "query";
  const safe = base.replace(/[/\\]/g, "_");
  return /\.(sql|txt)$/i.test(safe) ? safe : `${safe}.sql`;
}

/** 「すべて保存」(#1631) の 1 件。 */
export interface SaveAllEntry {
  tabId: string;
  fileName: string;
  sql: string;
  encoding: TextEncodingId;
}

/**
 * 開いているタブから「すべて保存」の対象を決める。本文が空白だけのタブ・クエリ以外のタブは対象外。
 * 既定ファイル名は `sqlSaveFileName` を使い、同名のタブがあるときは `name (2).sql` のように連番を付ける。
 */
export function planSaveAll(
  tabs: readonly { id: string; kind: string; title: string; fileEncoding?: TextEncodingId | null }[],
  getSql: (id: string) => string,
): SaveAllEntry[] {
  const used = new Set<string>();
  const out: SaveAllEntry[] = [];
  for (const tab of tabs) {
    if (tab.kind !== "query") continue;
    const sql = getSql(tab.id);
    if (sql.trim().length === 0) continue;
    const base = sqlSaveFileName(tab.title);
    let fileName = base;
    for (let n = 2; used.has(fileName.toLowerCase()); n += 1) {
      const m = /^(.*?)(\.[^.]*)$/.exec(base);
      fileName = m ? `${m[1]} (${n})${m[2]}` : `${base} (${n})`;
    }
    used.add(fileName.toLowerCase());
    out.push({ tabId: tab.id, fileName, sql, encoding: tab.fileEncoding ?? "utf-8" });
  }
  return out;
}
