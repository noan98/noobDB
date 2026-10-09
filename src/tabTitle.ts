/**
 * クエリタブのタイトル規則 (#1390)。副作用なしの純ロジック。
 *
 * - 自動命名: クエリ実行時に SQL の先頭行から付ける (編集のたびには変えない)。
 * - 手動リネーム済み (`titleManual`) のタブは自動命名で上書きしない。
 */

/** タイトルとして残す先頭行の最大文字数 (超えたら末尾を「…」に置き換える)。 */
const TITLE_MAX = 28;

/**
 * SQL の先頭の非空行を短く切り詰めてタイトルにする。空 (空白のみ) なら `untitled`。
 * 複数結果タブ (新規タブで実行) と、クエリタブの自動命名で共通に使う。
 */
export function deriveResultTabTitle(sql: string, untitled: string): string {
  const firstLine = sql.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!firstLine) return untitled;
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
}

/** 自動命名の判定に必要なタブの最小情報。 */
export interface AutoTitleTab {
  kind: "table" | "query" | "explain";
  title: string;
  /** ユーザが明示的にリネームした (または名前付きで開いた) タブ。 */
  titleManual?: boolean;
}

/**
 * クエリ実行時の自動命名。新しいタイトルを返す。変更不要なら `null`。
 * - query 以外 (table / explain) は対象外。
 * - `titleManual` のタブは上書きしない。
 * - 空 SQL の実行は既定名 (`untitled`) に戻す。
 */
export function autoTitleOnRun(tab: AutoTitleTab, sql: string, untitled: string): string | null {
  if (tab.kind !== "query" || tab.titleManual) return null;
  const next = deriveResultTabTitle(sql, untitled);
  return next === tab.title ? null : next;
}

/** リネーム確定の結果。 */
export interface RenameResult {
  title: string;
  titleManual: boolean;
}

/**
 * インライン編集 / メニューからのリネーム確定。前後の空白は落とす。
 * 空文字なら手動指定を解除して自動命名へ戻す (`sql` から導出し直す。空 SQL なら既定名)。
 * 入力が現在のタイトルと同じで、すでに手動なら変更なし (`null`)。
 */
export function applyRename(
  tab: AutoTitleTab,
  input: string,
  sql: string,
  untitled: string,
): RenameResult | null {
  const name = input.trim();
  if (name === "") {
    const title = tab.kind === "query" ? deriveResultTabTitle(sql, untitled) : untitled;
    if (!tab.titleManual && title === tab.title) return null;
    return { title, titleManual: false };
  }
  if (tab.titleManual && name === tab.title) return null;
  return { title: name, titleManual: true };
}
