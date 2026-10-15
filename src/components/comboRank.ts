// ComboSelect の候補絞り込み順位付け (#1631)。副作用なし。
//
// 部分一致した候補を「完全一致 → 前方一致 → 単語境界の前方一致 → それ以外の部分一致」の
// 順に並べる。列が 2000 個あるテーブルでも、`user` と打てば `user_id` より `user` が先頭に来る。
// 同じ段の中は元の並び (= 列の定義順など、呼び出し側が意味を持たせた順) を保つ。

/** 単語の区切り (snake_case / kebab-case / ドット / 空白)。 */
const SEPARATOR = /[\s_\-.:/]/;

/** 順位の段。小さいほど上位。一致しなければ null。 */
export function comboMatchTier(value: string, needle: string): number | null {
  const v = value.toLowerCase();
  const n = needle.toLowerCase();
  if (!n) return 0;
  if (v === n) return 0;
  if (v.startsWith(n)) return 1;
  let idx = v.indexOf(n);
  if (idx < 0) return null;
  // 単語境界 (区切りの直後 / camelCase の大文字の位置) で始まる一致は次点。
  while (idx >= 0) {
    if (idx > 0) {
      const prev = value[idx - 1];
      const cur = value[idx];
      if (SEPARATOR.test(prev) || (prev !== prev.toUpperCase() && cur !== cur.toLowerCase())) return 2;
    }
    idx = v.indexOf(n, idx + 1);
  }
  return 3;
}

/** `needle` に部分一致する候補を順位付きで返す。`needle` が空なら入力をそのまま返す。 */
export function rankComboOptions<T extends { value: string }>(options: readonly T[], needle: string): T[] {
  const n = needle.trim();
  if (!n) return options.slice();
  const ranked: { opt: T; tier: number; i: number }[] = [];
  options.forEach((opt, i) => {
    const tier = comboMatchTier(opt.value, n);
    if (tier !== null) ranked.push({ opt, tier, i });
  });
  ranked.sort((a, b) => a.tier - b.tier || a.i - b.i);
  return ranked.map((r) => r.opt);
}
