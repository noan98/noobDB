/**
 * `.sql` スクリプトの明示的な「開く」/「名前を付けて保存」導線 (#918) が使う純粋
 * ヘルパー。ドラッグ&ドロップ (`App.tsx` の `handleFilesDropped`) と読み込みロジック
 * (`api.readTextFile`) をそのまま共有するため、ここに置くのは「保存ダイアログの
 * 既定ファイル名を組み立てる」部分だけ — App.tsx から切り離してユニットテストする。
 */

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
