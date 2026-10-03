import { useMemo, useRef } from "react";

type AnyFn = (...args: never[]) => unknown;

/**
 * コールバックの束を「参照が変わらない関数」の束に変換する (#1314)。
 *
 * `memo` 化した子 (スキーマツリーなど) へ渡すハンドラが `tabs` / `activeTab` /
 * `settings` のような頻繁に変わる値を依存に持っていると、打鍵やストリーミングの
 * バッチのたびに新しい関数になり、`memo` が毎回破られる。ここでは最新のハンドラを
 * ref に保持し、子には常に同じ参照のラッパーを渡す。ラッパーは呼ばれた時点の最新の
 * ハンドラへ委譲するので、クロージャが古い値を掴むことはない。
 *
 * 値が `undefined` のキー (接続前だけ渡さないハンドラなど) は `undefined` のまま
 * 返す。どのキーが定義済みかが変わったときだけラッパーを作り直す。
 */
export function useStableCallbacks<T extends Record<string, AnyFn | undefined>>(latest: T): T {
  const ref = useRef(latest);
  ref.current = latest;
  const presence = Object.keys(latest)
    .map((key) => `${key}:${latest[key] === undefined ? 0 : 1}`)
    .join(",");
  // `presence` が変わらない限りラッパーは同一参照のまま (ref の中身だけが更新される)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: presence は「どのキーが定義済みか」の署名で、本体は ref 経由で最新値を読むため latest は依存に入れない (入れると毎レンダーでラッパーが作り直される)
  return useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(ref.current)) {
      out[key] =
        ref.current[key] === undefined
          ? undefined
          : (...args: unknown[]) => (ref.current[key] as (...a: unknown[]) => unknown)(...args);
    }
    return out as T;
  }, [presence]);
}
