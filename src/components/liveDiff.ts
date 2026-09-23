/**
 * ライブ監視パネル (プロセス監視 / 計画ウォッチ) の「前回スナップショットとの差分」
 * を求める純ロジック (#1022)。
 *
 * ポーリングで一覧を丸ごと差し替えるビューは、そのままだと値が黙って書き換わる
 * だけで「どこが動いたか」が読み取れない。ここでは行 ID (プロセス ID / スニペット
 * ID) で前回と今回の行を突き合わせ、**両方に存在する行**について、どのフィールドが
 * 変化したかを返す。描画側 (`LiveRows.tsx`) はこの結果で変化セルだけを一瞬
 * フラッシュさせる。
 *
 * - 新規に現れた行・消えた行は結果に含めない (行の enter / exit モーションが
 *   担当するので、セル単位のフラッシュを重ねない)。
 * - `prev` が `null` (= 初回表示) のときは空 — 初期表示で全セルが光らないように。
 * - 変化判定はフィールドごとの述語に委ねる。経過時間のように「毎ティック単調に
 *   増えるのが正常」な値は、述語側で「巻き戻った (= 新しい文が始まった)」ときだけ
 *   変化とみなせる (`processList.ts` の `PROCESS_LIVE_FIELDS` を参照)。
 */

/** 1 フィールド分の変化判定。 */
export interface LiveField<T, F extends string> {
  name: F;
  /** 同じ行 ID の前回値 `prev` と今回値 `next` を比べ、フラッシュに値する変化か。 */
  changed: (prev: T, next: T) => boolean;
}

/** 行 ID → 変化したフィールド名の集合。変化の無い行はキーごと含まない。 */
export type LiveChanges<K, F extends string> = ReadonlyMap<K, ReadonlySet<F>>;

export function diffLiveRows<T, K, F extends string>(
  prev: readonly T[] | null,
  next: readonly T[],
  keyOf: (row: T) => K,
  fields: readonly LiveField<T, F>[],
): LiveChanges<K, F> {
  const out = new Map<K, Set<F>>();
  if (prev === null || prev.length === 0 || next.length === 0) return out;
  // 同じ ID が重複して返ってきた場合は先勝ち (描画側の key も先勝ちで 1 行に揃う)。
  const before = new Map<K, T>();
  for (const row of prev) {
    const k = keyOf(row);
    if (!before.has(k)) before.set(k, row);
  }
  const seen = new Set<K>();
  for (const row of next) {
    const k = keyOf(row);
    if (seen.has(k)) continue;
    seen.add(k);
    const old = before.get(k);
    if (old === undefined) continue;
    let changed: Set<F> | null = null;
    for (const f of fields) {
      if (f.changed(old, row)) {
        if (changed === null) changed = new Set<F>();
        changed.add(f.name);
      }
    }
    if (changed !== null) out.set(k, changed);
  }
  return out;
}

/**
 * 行 ID の重複を先勝ちで取り除く。ポーリング結果に同じ ID が 2 回現れると
 * React の key が衝突し、`AnimatePresence` が行の出入りを取り違えて (退出中の
 * 行が残る / 別の行が消える) 表示がガタつくため、描画前に必ず一意化する。
 * 重複が無ければ入力配列をそのまま返す (参照が安定し、余計な再描画を起こさない)。
 */
export function uniqueByKey<T, K>(rows: readonly T[], keyOf: (row: T) => K): readonly T[] {
  const seen = new Set<K>();
  let dup = false;
  for (const row of rows) {
    const k = keyOf(row);
    if (seen.has(k)) {
      dup = true;
      break;
    }
    seen.add(k);
  }
  if (!dup) return rows;
  seen.clear();
  return rows.filter((row) => {
    const k = keyOf(row);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
