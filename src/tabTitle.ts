/**
 * クエリタブの自動命名とリネーム (#1390) の純ロジック。副作用なし。
 *
 * ルール:
 * - 自動命名の対象は **query タブだけ**。table タブは `db.table`、EXPLAIN タブは
 *   `EXPLAIN: …` と、開いた対象から決まる固有のタイトルを持つので自動では変えない
 *   (リネームも query タブのみ)。
 * - タイトルは SQL の最初の「コメントでも空行でもない行」から作る。実行のたびに直近に実行した
 *   SQL へ追従するが、利用者が手動で付けた名前 (`titleManual`) は決して上書きしない。
 * - 空 SQL・コメントだけの SQL は命名しない (既存のタイトルを保つ)。
 */

/** タイトルの最大表示文字数 (これを超えると末尾を「…」に切り詰める)。 */
export const TAB_TITLE_MAX = 28;

/** 手動リネームで受け付ける最大文字数。 */
export const TAB_RENAME_MAX = 60;

/** 命名に必要なタブの最小フィールド。 */
export interface TitledTab {
  kind: "table" | "query" | "explain";
  title: string;
  /** 利用者が手動で付けた名前か。true の間は自動命名で上書きしない。 */
  titleManual?: boolean;
}

/** ブロックコメント (未終端を含む) を空白に置き換える。 */
function stripBlockComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
}

/**
 * SQL からタブ名を導出する。先頭の非コメント行を `TAB_TITLE_MAX` 文字へ切り詰める。
 * 空・コメントだけなら null。
 */
export function deriveQueryTabTitle(sql: string): string | null {
  const line = stripBlockComments(sql)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("--") && !l.startsWith("#"));
  if (!line) return null;
  const oneLine = line.replace(/\s+/g, " ");
  return oneLine.length > TAB_TITLE_MAX ? `${oneLine.slice(0, TAB_TITLE_MAX - 1)}…` : oneLine;
}

/**
 * 実行時の自動命名。新しいタイトルを返す。変更が要らなければ null
 * (query 以外 / 手動命名 / 命名できない SQL / 既に同じ名前)。
 */
export function autoTitleOnRun(tab: TitledTab, sql: string): string | null {
  if (tab.kind !== "query" || tab.titleManual) return null;
  const derived = deriveQueryTabTitle(sql);
  return derived !== null && derived !== tab.title ? derived : null;
}

/**
 * 新規に追加するタブのタイトルと手動フラグを確定する (addTab 経由の全経路で共通)。
 * - 手動フラグが立っていれば何も変えない。
 * - タイトルが無題プレースホルダなら SQL から自動命名する (命名できなければそのまま)。
 * - フラグ未指定で、プレースホルダでも SQL 由来でもないタイトル (スニペット名・
 *   オブジェクト名など呼び出し側が明示した名前) は、後の実行で上書きされないよう手動扱いにする。
 * - フラグが明示されている (復元・複製) ときは、その意味を尊重して推測しない。
 */
export function resolveNewTabTitle(
  tab: TitledTab & { sql: string },
  untitled: string,
): { title: string; titleManual: boolean | undefined } {
  if (tab.kind !== "query" || tab.titleManual) return { title: tab.title, titleManual: tab.titleManual };
  if (tab.title === untitled) {
    return { title: deriveQueryTabTitle(tab.sql) ?? tab.title, titleManual: false };
  }
  if (tab.titleManual === undefined) {
    const derived = deriveQueryTabTitle(tab.sql);
    return { title: tab.title, titleManual: derived === null || derived !== tab.title };
  }
  return { title: tab.title, titleManual: tab.titleManual };
}

/** リネーム確定の結果。null なら変更なし。 */
export interface RenamePatch {
  title: string;
  titleManual: boolean;
}

/**
 * インライン編集の確定値からタブへ適用するパッチを決める。
 * - query 以外はリネーム不可 (null)。
 * - 前後の空白を除き `TAB_RENAME_MAX` 文字までに切る。
 * - 空にした場合は「自動命名に戻す」: 手動フラグを外し、現在の SQL から導出し直す
 *   (導出できなければ無題プレースホルダ)。
 * - 現在と同じ名前なら変更なし (手動フラグも立てない)。
 */
export function resolveRename(
  tab: TitledTab,
  input: string,
  currentSql: string,
  untitled: string,
): RenamePatch | null {
  if (tab.kind !== "query") return null;
  const name = input.trim().slice(0, TAB_RENAME_MAX).trim();
  if (name === "") {
    const title = deriveQueryTabTitle(currentSql) ?? untitled;
    if (!tab.titleManual && title === tab.title) return null;
    return { title, titleManual: false };
  }
  if (name === tab.title) return null;
  return { title: name, titleManual: true };
}
