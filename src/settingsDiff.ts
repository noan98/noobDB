// 設定インポート前の差分プレビュー (#1631)。現在の設定と取り込む設定を比べ、変わる項目のパスを返す純関数。
// 項目名は設定のキーそのもの (画面ラベルは項目ごとに散らばっているため)。オブジェクト値は 1 段だけ掘り下げ、
// `ai.model` のように示す。配列は丸ごと 1 項目として比べる。

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!sameValue(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** 値が違う項目のパスを、キー順で返す (秘密値は設定ストアに無いので値そのものは返さない)。 */
export function diffSettingsPaths(current: object, next: object): string[] {
  const a = current as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const out: string[] = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (sameValue(av, bv)) continue;
    if (isPlainObject(av) && isPlainObject(bv)) {
      const sub = [...new Set([...Object.keys(av), ...Object.keys(bv)])].sort();
      for (const s of sub) if (!sameValue(av[s], bv[s])) out.push(`${k}.${s}`);
    } else {
      out.push(k);
    }
  }
  return out;
}
