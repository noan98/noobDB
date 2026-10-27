import { reducedMotionActive } from "../motion";
import { FIRST_BATCH_REVEAL_MAX_STEPS } from "./firstBatchReveal";
import { prefersStaticMotion } from "./revealOrigin";

/**
 * ユーザ / 権限管理パネル (`UsersPanel.tsx`, #1890) の motion の純ロジック。
 *
 * - 権限の適用 / 剥奪後に「どの行のどのセルが変わったか」を再取得結果の差分から求め、
 *   そのセルへ `apply-flash` (App.css の `.flash-ring`) を 1 回再生する。
 * - ユーザ一覧・権限マトリクスの入場 stagger は段数に上限を設ける。
 */

type FlagKey = "select" | "insert" | "update" | "delete" | "ddl";
type FlagRow = Readonly<Record<FlagKey, boolean>>;

const FLAG_KEYS: readonly FlagKey[] = ["select", "insert", "update", "delete", "ddl"];
const NO_FLAGS: FlagRow = { select: false, insert: false, update: false, delete: false, ddl: false };

/** 変わったセル。表名 → 変わった権限列の集合。 */
export type ChangedPrivilegeCells = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * 適用前 (`before`) と再取得後 (`after`) の権限マトリクスを比べ、値が変わったセルを返す。
 * 片方にしか無い表は、無い側を全 OFF として扱う (新規 GRANT で行が現れた場合も光らせる)。
 * 行ごとの Set は変わった列だけを持ち、変化の無い行はキーごと含めない。
 */
export function changedPrivilegeCells(
  before: Readonly<Record<string, FlagRow>>,
  after: Readonly<Record<string, FlagRow>>,
): ChangedPrivilegeCells {
  const out = new Map<string, ReadonlySet<string>>();
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[table] ?? NO_FLAGS;
    const a = after[table] ?? NO_FLAGS;
    const cols = FLAG_KEYS.filter((f) => b[f] !== a[f]);
    if (cols.length > 0) out.set(table, new Set(cols));
  }
  return out;
}

/** 新しく加わったロール (剥奪されたロールは行ごと消えるので対象外)。 */
export function addedRoles(prev: readonly string[], next: readonly string[]): ReadonlySet<string> {
  const had = new Set(prev);
  return new Set(next.filter((r) => !had.has(r)));
}

/**
 * ユーザ一覧 / 権限マトリクスで入場 stagger を再生する先頭の件数。`FIRST_BATCH_REVEAL_MAX_STEPS`
 * (結果グリッドの初回リビールと同じ 12 段) に揃える。これ以降の項目は stagger に載せず
 * 即時に出すので、件数が多くても総所要時間が伸びない。
 */
export const USERS_PANEL_STAGGER_MAX_STEPS = FIRST_BATCH_REVEAL_MAX_STEPS;

/** `index` 番目 (0 始まり) の項目を stagger に載せるか。 */
export function isStaggerAnimated(index: number): boolean {
  return index >= 0 && index < USERS_PANEL_STAGGER_MAX_STEPS;
}

/**
 * 面内フラッシュを出してよいか。reduced-motion に加え、ハイコントラスト /
 * forced-colors では装飾的な光り方をしない。
 */
export function shouldPlayPrivilegeFlash(): boolean {
  return !reducedMotionActive() && !prefersStaticMotion();
}
