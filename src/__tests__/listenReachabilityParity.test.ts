import { describe, expect, it } from "vitest";
import { reachableModules, stripCommentsAndStrings, toSrcRelative } from "./moduleGraph";

// listen ラッパーの UI 到達性パリティ (#2028, Epic #2012)。
//
// `apiReachabilityParity.test.ts` は `api` オブジェクトのメンバ (invoke 側) だけを見ており、
// `tauri.ts` にスタンドアロン export されたイベント購読ラッパー `listenXxx` は対象外だった。
// `streamEventParity` は Rust emit とのイベント名一致、knip は「どこかから import されている」
// ことしか見ないため、消費コンポーネントが `main.tsx` から到達しなくなってもストリーミング
// 機能一式が静かに死蔵する。ここで invoke 側 (#907 / #1421) と同じ到達性を要求する。

const allSources: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ).map(([key, src]) => [toSrcRelative(key), src]),
);

const ENTRY = "main.tsx";
const reachable = reachableModules([ENTRY], allSources);

/** `api/` 配下 (ラッパー本体) と `__tests__/` 配下 (テストだけの呼び出し) は消費側に数えない。 */
const isConsumer = (path: string) => !path.startsWith("api/") && !path.startsWith("__tests__/");
const consumerSources = Object.entries(allSources)
  .filter(([path]) => isConsumer(path))
  .map(([path, src]) => [path, stripCommentsAndStrings(path, src)] as [string, string]);
const reachableConsumers = consumerSources.filter(([path]) => reachable.has(path));

/**
 * 意図的に UI から呼ばれない listen ラッパーの許可リスト。**空のまま維持するのが理想**で、
 * 追加するときは「なぜ UI から呼ばれないのに残すのか」を必ず併記すること。
 */
const INTENTIONALLY_UNREACHABLE_LISTENERS: Record<string, string> = {};

/** `tauri.ts` から `export (async) function listenXxx` を機械抽出する。 */
function extractListeners(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(listen[A-Za-z0-9_]*)\b/gm)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

const listeners = extractListeners(allSources["api/tauri.ts"] ?? "");

/** `listenXxx(` の呼び出し (または参照) を探す。 */
function referencedBy(name: string, sources: [string, string][] = reachableConsumers): string[] {
  const re = new RegExp(`\\b${name}\\b`);
  return sources.filter(([, src]) => re.test(src)).map(([path]) => path);
}

describe("listen ラッパー到達性パリティ (tauri.ts の listen* ↔ UI からの参照, #2028)", () => {
  it("listen* を十分な数だけ抽出できている (抽出ロジックの保険)", () => {
    expect(listeners.length).toBeGreaterThanOrEqual(16);
    for (const name of ["listenQueryStream", "listenAiStream", "listenTransferStream"]) {
      expect(listeners, name).toContain(name);
    }
  });

  it("抽出ロジックが async の有無を問わず拾い、コメント内の宣言は拾わない", () => {
    const src = [
      "export function listenA() {}",
      "export async function listenB() {}",
      "// export function listenC() {}",
    ].join("\n");
    expect(extractListeners(src)).toEqual(["listenA", "listenB"]);
  });

  it("main.tsx からのモジュールグラフが UI の主要部分を含んでいる (グラフ構築の保険)", () => {
    expect(reachable.has(ENTRY)).toBe(true);
    expect(reachable.has("components/QueryEditor.tsx")).toBe(true);
    expect(reachableConsumers.length).toBeGreaterThanOrEqual(100);
  });

  it("UI から一度も呼ばれない listen ラッパーが無い (main.tsx から到達するモジュールで判定)", () => {
    const unreachable = listeners
      .filter((name) => !(name in INTENTIONALLY_UNREACHABLE_LISTENERS))
      .filter((name) => referencedBy(name).length === 0);
    const detail = unreachable
      .map((name) => {
        const dead = referencedBy(name, consumerSources);
        return dead.length > 0 ? `${name} (到達しないモジュールからのみ参照: ${dead.join(", ")})` : name;
      })
      .join(", ");
    expect(
      unreachable,
      `UI から到達不能な listen ラッパー (削除するか、理由を添えて INTENTIONALLY_UNREACHABLE_LISTENERS へ): ${detail}`,
    ).toEqual([]);
  });

  it("許可リストが実態と合っている (到達可能になった / 消えたエントリは外す)", () => {
    const stale = Object.keys(INTENTIONALLY_UNREACHABLE_LISTENERS)
      .filter((name) => !listeners.includes(name) || referencedBy(name).length > 0)
      .sort();
    expect(stale, `不要になった許可リストのエントリ: ${stale.join(", ")}`).toEqual([]);
  });
});
