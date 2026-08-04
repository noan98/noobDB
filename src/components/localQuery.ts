// ローカル横断クエリ (#740) の純ロジック。結果セットをローカルテーブルとして
// 登録する前の、フロント側の入力補助/ガードのみを担う (実際の型マッピング・
// 上限行数の強制はバックエンド `commands/local.rs` / `db/sqlite.rs` が担う —
// ここでの判定をすり抜けても最終的にはバックエンドの `MAX_LOCAL_TABLE_ROWS`
// エラーとして表面化する)。

/**
 * 1 回の登録で取り込める最大行数。バックエンドの同名定数
 * (`src-tauri/src/commands/local.rs::MAX_LOCAL_TABLE_ROWS`) と値を揃えており、
 * フロントは登録前にこの値を超えていれば確定ボタンを無効化して早めに知らせる
 * (受け入れ条件「上限行数を明示する」)。
 */
export const MAX_LOCAL_TABLE_ROWS = 200_000;

/**
 * 既存のローカルテーブル名と衝突しない候補名 (`r1`, `r2`, ...) を提案する。
 * 大小無視で比較する — 実際の作成 (`register_local_table`) は同名なら**上書き**
 * になるため、これは「意図せず上書きしてしまう」事故を防ぐ初期値のヒントに過ぎない。
 */
export function suggestLocalTableName(existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  let n = 1;
  while (taken.has(`r${n}`)) n += 1;
  return `r${n}`;
}
