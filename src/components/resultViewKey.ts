/**
 * 結果ビュー (チャート/ピボット) 設定の永続化キー生成 (#909)。
 *
 * 列幅/フッター/ソートなどテーブル形状ベースの永続化 (`colStateKeyFrom` /
 * `footerStateKeyFrom` / `gridViewStateKeyFrom`) は `database + table + 列名の
 * signature` をキーにしているが、これは「テーブルを開いたときの結果」を前提にした
 * 設計で、database/table を持たない自由形式クエリでは意味を持たない
 * (`database`/`table` が両方空文字になり、列構成が同じ別クエリ同士が衝突する)。
 *
 * チャート/ピボットは自由形式クエリの結果に対しても使われ、要件は「同じクエリを
 * 再実行・タブ復元・再起動しても設定が残る」ことなので、**実行 SQL のテキスト**を
 * キーの一部にする。SQL が空/未実行なら永続化しない (`undefined` を返す)。
 */

/**
 * 安定した非暗号ハッシュ (djb2 系)。ストレージキーの短縮用途のみで、衝突耐性や
 * 予測不能性は求めない。`cellFormat.ts` の `enumBadgeHue` と同じ発想の 32bit 版。
 */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * 実行 SQL からビュー設定の永続化キーを作る。前後の空白差は同一視するが、SQL 本文
 * が変われば別クエリとして扱う (安全側)。SQL が無い (未実行/空文字) ときは
 * `undefined` を返し、呼び出し側はこれを見て永続化をスキップする。
 */
export function resultViewKey(namespace: string, sql: string | undefined): string | undefined {
  const trimmed = sql?.trim();
  if (!trimmed) return undefined;
  return `${namespace}::${hashString(trimmed)}`;
}
