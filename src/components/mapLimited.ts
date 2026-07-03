/**
 * 並列数を制限した非同期 map。大きなスキーマで `describeTable` などの問い合わせを
 * 同時に大量へ開かないための共有ユーティリティ (ER 図とスキーマエクスポートが使う)。
 * 結果の順序は `items` と一致する。
 */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
