import { useMemo, useRef } from "react";

type AnyFn = (...args: never[]) => unknown;

export interface KeyedStable {
  /**
   * `key` ごとに参照が変わらない関数を返す (#1313)。呼ばれた時点の最新の `fn` へ委譲するので、
   * クロージャが古い値を掴むことはない。`key` にはタブ ID などを含める
   * (例: `${tab.id}:setCell`)。
   */
  fn<F extends AnyFn>(key: string, fn: F): F;
  /** `deps` が (Object.is で) 変わらない間は同じ値を返す。`key` ごとに独立。 */
  memo<V>(key: string, deps: readonly unknown[], factory: () => V): V;
}

/**
 * ループの中 (タブごとの描画など) で、`memo` 化した子へ渡すコールバック・オブジェクトの
 * 参照を固定するためのキー付きキャッシュ。`useStableCallbacks` はキーが静的な束向けで、
 * こちらは `.map()` の中のようにフックを呼べない場所向け。
 *
 * エントリは `key` ごとに 1 つで、使われなくなったキーは `prune` で捨てられる
 * (呼び出し側が生きているキーの接頭辞を渡す)。
 */
export function useKeyedStable(): KeyedStable & { prune(alive: (key: string) => boolean): void } {
  const fns = useRef(new Map<string, { latest: AnyFn; wrapper: AnyFn }>());
  const memos = useRef(new Map<string, { deps: readonly unknown[]; value: unknown }>());
  return useMemo(
    () => ({
      fn<F extends AnyFn>(key: string, fn: F): F {
        let entry = fns.current.get(key);
        if (!entry) {
          const created: { latest: AnyFn; wrapper: AnyFn } = {
            latest: fn,
            wrapper: (...args) => (created.latest as (...a: unknown[]) => unknown)(...args),
          };
          fns.current.set(key, created);
          entry = created;
        }
        entry.latest = fn;
        return entry.wrapper as F;
      },
      memo<V>(key: string, deps: readonly unknown[], factory: () => V): V {
        const hit = memos.current.get(key);
        if (
          hit &&
          hit.deps.length === deps.length &&
          hit.deps.every((d, i) => Object.is(d, deps[i]))
        ) {
          return hit.value as V;
        }
        const value = factory();
        memos.current.set(key, { deps, value });
        return value;
      },
      prune(alive: (key: string) => boolean) {
        for (const k of Array.from(fns.current.keys())) if (!alive(k)) fns.current.delete(k);
        for (const k of Array.from(memos.current.keys())) if (!alive(k)) memos.current.delete(k);
      },
    }),
    [],
  );
}
