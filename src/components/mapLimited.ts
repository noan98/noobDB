/**
 * 並列数を制限した非同期 map。大きなスキーマで `describeTable` などの問い合わせを
 * 同時に大量へ開かないための共有ユーティリティ (ER 図とスキーマエクスポートが使う)。
 * 結果の順序は `items` と一致する。
 */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  // 1 件でも失敗したら残りの項目は開始しない。Promise.all は最初の reject で返るが、
  // 他のワーカーが残りを処理し続けると、捨てられる結果のための問い合わせが走り続ける (#1534)。
  let failed = false;
  // limit <= 0 だとワーカーが 1 つも生まれず undefined 埋めの配列が黙って返る
  // ため、最低 1 ワーカーへ正規化する。
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return out;
}
