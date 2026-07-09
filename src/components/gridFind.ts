import type { CellValue } from "../api/tauri";

/**
 * 結果グリッドの値検索 (Find in Results, #644) の純ロジック。
 *
 * 取得済み行 (在メモリ) を横断してヒットセルを列挙し、次/前ヒットの
 * インデックス算出・ストリーミングで行が増えたときの現在ヒット維持を担う。
 * すべて副作用なしの純関数で、`ResultGrid` の検索バーとハイライト描画が
 * 消費する。`gridStats.ts` (選択サマリ/列統計) と同じ分離方針。
 *
 * 列フィルタ (`ColumnFilter`) が「条件に合わない行を隠す」のに対し、こちらは
 * 行を隠さずヒットセルへジャンプする「読みながら探す」操作である点が異なる。
 */

/** 検索オプション。すべて既定 off (大小無視の部分一致)。 */
export interface GridFindOptions {
  /** true なら大文字小文字を区別する。 */
  caseSensitive: boolean;
  /** true ならセル値全体との完全一致のみをヒットとする。 */
  wholeCell: boolean;
  /** true ならクエリを正規表現として解釈する。 */
  regex: boolean;
}

/** 1 件のヒット。`rows` 配列に対する元 (取得順) の行/列インデックス。 */
export interface GridFindMatch {
  rowIdx: number;
  colIdx: number;
}

export interface GridFindResult {
  /** 行優先 (行 → 列) の出現順に並んだヒット一覧。 */
  matches: GridFindMatch[];
  /** 正規表現モードでクエリがコンパイル不能だったとき true (matches は空)。 */
  invalidRegex: boolean;
}

/** 空の検索結果。参照が安定しているので useMemo/useEffect の依存に使える。 */
export const EMPTY_FIND_RESULT: GridFindResult = { matches: [], invalidRegex: false };

/**
 * クエリ + オプションからセル文字列の判定関数を作る。正規表現が不正なら null。
 * 大小無視の非正規表現検索はクエリ側の小文字化を 1 回で済ませる。
 */
function buildMatcher(
  query: string,
  options: GridFindOptions,
): ((cellText: string) => boolean) | null {
  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(
        options.wholeCell ? `^(?:${query})$` : query,
        options.caseSensitive ? "" : "i",
      );
    } catch {
      return null;
    }
    // g フラグを付けないので lastIndex の持ち越しは無い。
    return (s) => re.test(s);
  }
  const q = options.caseSensitive ? query : query.toLowerCase();
  if (options.wholeCell) {
    return (s) => (options.caseSensitive ? s : s.toLowerCase()) === q;
  }
  return (s) => (options.caseSensitive ? s : s.toLowerCase()).includes(q);
}

/**
 * 取得済み行からヒットセルを列挙する。
 *
 * - 空クエリはヒット 0 件 (空白のみのクエリはデータ中の空白を探せるよう有効)。
 * - NULL/undefined セルは対象外 (グリッドの NULL バッジは表示専用の文字列で、
 *   実データに "NULL" という文字は無いため)。
 * - それ以外のセルは `String(v)` (グリッドのコピーと同じ実値テキスト) で判定する。
 * - 順序は行優先 (上の行 → 左の列) で、Enter の次ヒット送りがこの順に進む。
 */
export function computeFindMatches(
  rows: CellValue[][],
  columnCount: number,
  query: string,
  options: GridFindOptions,
): GridFindResult {
  if (query === "" || rows.length === 0 || columnCount <= 0) return EMPTY_FIND_RESULT;
  const matcher = buildMatcher(query, options);
  if (!matcher) return { matches: [], invalidRegex: true };
  const matches: GridFindMatch[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const n = Math.min(columnCount, row.length);
    for (let c = 0; c < n; c++) {
      const v = row[c];
      if (v === null || v === undefined) continue;
      if (matcher(String(v))) matches.push({ rowIdx: r, colIdx: c });
    }
  }
  return { matches, invalidRegex: false };
}

/** ヒットの一意キー ("row:col")。ハイライト用 Set / 現在ヒット比較に使う。 */
export function findMatchKey(m: GridFindMatch): string {
  return `${m.rowIdx}:${m.colIdx}`;
}

/** ヒット一覧をセル単位の高速参照用 Set に変換する。 */
export function buildFindKeySet(matches: GridFindMatch[]): Set<string> {
  return new Set(matches.map(findMatchKey));
}

/**
 * 次/前ヒットのインデックスを wrap-around 付きで返す。
 * ヒット 0 件なら null。現在位置が無い (null) 場合は先頭 (dir=1) / 末尾 (dir=-1)。
 */
export function nextMatchIndex(
  count: number,
  current: number | null,
  dir: 1 | -1,
): number | null {
  if (count <= 0) return null;
  if (current == null) return dir > 0 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/**
 * ヒット一覧が再計算されたとき (ストリーミングで行が増えた / オプション変更) に、
 * 現在ヒットをできるだけ維持した新しいインデックスを返す。
 *
 * 1. 直前の現在ヒットと同じセルが新しい一覧にあればそのインデックス。
 * 2. 無ければ直前のインデックスを新しい範囲にクランプ (近い位置を維持)。
 * 3. 直前の現在位置が無ければ先頭 (0)。ヒット 0 件なら null。
 */
export function stableMatchIndex(
  matches: GridFindMatch[],
  prevMatch: GridFindMatch | null,
  prevIndex: number | null,
): number | null {
  if (matches.length === 0) return null;
  if (prevMatch) {
    const i = matches.findIndex(
      (m) => m.rowIdx === prevMatch.rowIdx && m.colIdx === prevMatch.colIdx,
    );
    if (i >= 0) return i;
  }
  if (prevIndex == null) return 0;
  return Math.min(Math.max(prevIndex, 0), matches.length - 1);
}
