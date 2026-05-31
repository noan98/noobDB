import type { IconName } from "./Icon";

/**
 * コマンドパレット (Cmd/Ctrl+K) の純粋ロジック。検索・スコアリング・グループ化を
 * React から切り離してここに集約し、`src/__tests__/commandPalette.test.ts` で
 * ユニットテストできるようにする。コンポーネント (`CommandPalette.tsx`) は
 * この結果を描画し、キーボードナビゲーションと実行だけを担う。
 */

/** 候補のグループ種別。表示順は `GROUP_ORDER` で固定する。 */
export type CommandGroup = "navigation" | "connections" | "tables" | "snippets" | "history";

/** グループの表示順 (上から下)。空のグループは描画時に省かれる。 */
export const GROUP_ORDER: CommandGroup[] = [
  "navigation",
  "connections",
  "tables",
  "snippets",
  "history",
];

/** パレットに並ぶ 1 候補。`run` は選択時 (Enter / クリック) に実行される。 */
export interface CommandItem {
  /** 一意なキー (React の key / アクティブ判定に使用)。 */
  id: string;
  group: CommandGroup;
  /** 主表示テキスト。検索のハイライト対象でもある。 */
  label: string;
  /** 副表示テキスト (接続先・DB 名・フォルダなど)。検索対象だがハイライトはしない。 */
  sublabel?: string;
  /** ラベルに出さない追加の検索語 (タグ・SQL 全文など)。 */
  keywords?: string;
  /** 行頭アイコン。 */
  icon?: IconName;
  /** 行末に出す短いバッジ (本番 / 読み取り専用 / ドライバ名など)。 */
  badges?: string[];
  /** 選択時の動作。パレットは実行後に自分を閉じる。 */
  run: () => void;
}

/** ラベル中のマッチ範囲 (半開区間 [start, end))。ハイライト描画に使う。 */
export type MatchRange = [number, number];

export interface FuzzyMatch {
  score: number;
  ranges: MatchRange[];
}

export interface ScoredItem {
  item: CommandItem;
  score: number;
  /** ラベル中のマッチ範囲。副表示/keywords でのみマッチした場合は空。 */
  ranges: MatchRange[];
}

export interface GroupedCommands {
  group: CommandGroup;
  items: ScoredItem[];
}

/** 単語境界とみなす直前文字 (空白・区切り記号)。境界直後のマッチを優遇する。 */
const WORD_BOUNDARY = /[\s_\-./:()[\]]/;

/**
 * サブシーケンス方式のあいまい一致 (VS Code / fzf 風)。`query` の各文字が `text`
 * に同順で現れれば一致とし、スコアを返す。一致しなければ `null`。空クエリはスコア
 * 0・範囲なしで常に一致扱い。
 *
 * スコアリング方針 (重要な順):
 * - 連続マッチを強く優遇 (途切れない並びほど高い)。
 * - 最初にマッチした文字が単語の先頭 (文字列先頭 / 区切り直後) なら頭文字ボーナス。
 *   → "users" のような前方一致が、途中で一致する候補より上位になる。
 * - マッチ間の隙間 (gap) を減点。これにより短く密に一致する候補が、同じ部分列を
 *   含むだけの長い候補 (例: "users" vs "user_sessions") より上位になる。
 * - 文字列長で僅かにタイブレーク (短いものを優先)。
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (query === "") return { score: 0, ranges: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  const ranges: MatchRange[] = [];
  let prevMatch = -2;
  let rangeStart = -1;
  let first = true;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (first) {
      score += 10;
      // 先頭文字が単語境界 (文字列先頭 or 区切り直後) なら前方一致として強く優遇。
      if (ti === 0 || WORD_BOUNDARY.test(t[ti - 1])) score += 15;
      first = false;
    } else if (ti === prevMatch + 1) {
      // 直前の文字に連続 → 強いボーナス。
      score += 10;
    } else {
      // 隙間あり → 小さく加点しつつ、空いた幅に応じて減点 (上限つき)。
      score += 1 - Math.min(ti - prevMatch - 1, 10);
    }
    if (rangeStart === -1) {
      rangeStart = ti;
    } else if (ti !== prevMatch + 1) {
      ranges.push([rangeStart, prevMatch + 1]);
      rangeStart = ti;
    }
    prevMatch = ti;
    qi++;
  }
  if (qi < q.length) return null;
  ranges.push([rangeStart, prevMatch + 1]);
  // 長い文字列を僅かに減点して、短く一致する候補を同点時に優先する。
  score -= t.length * 0.1;
  return { score, ranges };
}

/** 1 候補を query でスコアリング。マッチしなければ `null`。 */
export function scoreItem(item: CommandItem, query: string): ScoredItem | null {
  if (query === "") return { item, score: 0, ranges: [] };
  const labelMatch = fuzzyMatch(query, item.label);
  const extra = [item.sublabel, item.keywords].filter(Boolean).join(" ");
  const extraMatch = extra ? fuzzyMatch(query, extra) : null;
  if (!labelMatch && !extraMatch) return null;
  // ラベル一致を副表示/keywords 一致より常に上位へ (大きめの加点)。
  const score = labelMatch ? labelMatch.score + 100 : extraMatch!.score;
  return { item, score, ranges: labelMatch?.ranges ?? [] };
}

/**
 * 候補を query で絞り込み、`GROUP_ORDER` の順にグループ化して返す。query が
 * 非空のときは各グループ内をスコア降順 (同点は入力順を維持) で並べ替える。空の
 * グループは含めない。
 */
export function groupCommands(items: CommandItem[], query: string): GroupedCommands[] {
  const byGroup = new Map<CommandGroup, ScoredItem[]>();
  for (const item of items) {
    const scored = scoreItem(item, query);
    if (!scored) continue;
    const arr = byGroup.get(item.group);
    if (arr) arr.push(scored);
    else byGroup.set(item.group, [scored]);
  }
  const result: GroupedCommands[] = [];
  for (const group of GROUP_ORDER) {
    const arr = byGroup.get(group);
    if (!arr || arr.length === 0) continue;
    // Array.prototype.sort は安定なので、同点は push 順 (= 入力順) のまま。
    if (query !== "") arr.sort((a, b) => b.score - a.score);
    result.push({ group, items: arr });
  }
  return result;
}

/** グループ化済み候補を表示順のフラット配列へ。キーボードナビの index 付けに使う。 */
export function flattenGroups(grouped: GroupedCommands[]): ScoredItem[] {
  return grouped.flatMap((g) => g.items);
}

/** ラベルをマッチ範囲で分割する。`highlighted` が true の断片を強調表示する。 */
export interface LabelSegment {
  text: string;
  highlighted: boolean;
}

export function splitLabel(label: string, ranges: MatchRange[]): LabelSegment[] {
  if (ranges.length === 0) return [{ text: label, highlighted: false }];
  const segments: LabelSegment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: label.slice(cursor, start), highlighted: false });
    segments.push({ text: label.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < label.length) segments.push({ text: label.slice(cursor), highlighted: false });
  return segments;
}

/** 履歴の SQL を 1 行候補に整形 (空白畳み + 長さ制限)。 */
export function singleLine(sql: string, max = 120): string {
  const collapsed = sql.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
