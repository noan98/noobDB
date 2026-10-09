import { describe, expect, it } from "vitest";
import { api } from "../api/tauri";
import { reachableModules, toSrcRelative } from "./moduleGraph";

// API 到達性パリティ検証 (#907 / #1421)。
//
// `ipcCommandParity.test.ts` は「lib.rs 登録 ⇔ tauri.ts ラッパ」の集合一致を担保
// するが、その先の「ラッパが UI から実際に呼ばれているか」は誰も見ていなかった。
// 結果として、バックエンドにも `tauri.ts` にも存在するのに **UI から一度も呼ばれない**
// ラッパー (デッドコード) が構造的に不可視になっていた:
//
// - **knip では原理的に検出できない**: `api` は単一オブジェクトとして export され
//   UI で使われているため、その**プロパティ単位**の未使用は見えない。
// - **`ipcCommandParity` はむしろ削除を妨げる**: 集合完全一致を強制するので、UI 未接続
//   のラッパーを消すと (対応する Rust コマンドも消さない限り) CI が落ちる。
//
// ここでは `tauri.ts` から `api` オブジェクトのプロパティ名を抽出し、**`src/main.tsx` から
// 実際の import でたどれるモジュール**に `api.<name>` の参照があるかを走査する。参照が
// 1 つも無いラッパーは「削除する」か「意図的な公開 API として許可リストへ入れる」かの
// どちらかを迫られる。
//
// #1421: 以前は `src/` 配下の**どこか**に文字列 `api.<name>` があれば到達可能と数えていた。
// それだと UI の入口 (App からの import) を外した機能でも、コンポーネント同士やテストが
// 互いに import し合っている限り参照が残り、機能一式が推移的に死蔵されたまま通過していた。
// 到達性を実モジュールグラフ (`moduleGraph.ts`) に裏打ちしてこの穴を塞ぐ。

/**
 * `src/` 配下の全 TS/TSX を `?raw` で読み込み、キーを `src/` からの相対パスへそろえる。
 */
const allSources: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../**/*.{ts,tsx}", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ).map(([key, src]) => [toSrcRelative(key), src]),
);

/** アプリのエントリ (`index.html` が読み込む唯一のスクリプト)。 */
const ENTRY = "main.tsx";

/** `main.tsx` から実行時 import でたどれるモジュール。 */
const reachable = reachableModules([ENTRY], allSources);

/**
 * 到達性の判定に使うソース。`api/` 配下 (`tauri.ts` と、ラッパー本体を分割した
 * `api/commands/*.ts`) と `__tests__/` 配下は対象外 (テストが呼んでいるだけの
 * ラッパーは UI から到達できていない)。
 */
const isConsumer = (path: string) =>
  !path.startsWith("api/") && !path.startsWith("__tests__/");
const consumerSources = Object.entries(allSources).filter(([path]) =>
  isConsumer(path),
);
const reachableConsumers = consumerSources.filter(([path]) =>
  reachable.has(path),
);

/**
 * 意図的に UI から呼ばれないラッパーの許可リスト。**空のまま維持するのが理想**で、
 * 追加するときは「なぜ UI から呼ばれないのに残すのか」を必ず併記すること。
 * 単に「まだ UI を作っていない」は理由にならない — その場合は UI を足すか、
 * ラッパーと Rust コマンドを一緒に消す (#907 の方針)。
 */
const INTENTIONALLY_UNREACHABLE: Record<string, string> = {};

/**
 * ラッパー名は `api` オブジェクトを実際に import して `Object.keys` で取る。
 * ソースを正規表現で舐めるより堅牢で、リネームやフォーマット変更に影響されない。
 */
const members = new Set(Object.keys(api));

/**
 * `api.<name>` の参照を探す。`api\n  .listFlightRecords(...)` のようにメソッド
 * チェーンが改行で折れている書き方も拾えるよう、`api` と `.` の間の空白を許す。
 * 既定では `main.tsx` から到達できるモジュールだけを見る。
 */
function referencedBy(
  name: string,
  sources: [string, string][] = reachableConsumers,
): string[] {
  const re = new RegExp(`\\bapi\\s*\\.\\s*${name}\\b`);
  return sources.filter(([, src]) => re.test(src)).map(([path]) => path);
}

describe("API 到達性パリティ (tauri.ts の api メンバ ↔ UI からの参照)", () => {
  it("api メンバを十分な数だけ抽出できている (抽出ロジックの保険)", () => {
    expect(members.size).toBeGreaterThanOrEqual(50);
    expect(members.has("connect")).toBe(true);
    expect(members.has("runQueryStream")).toBe(true);
  });

  it("走査対象のソースを十分な数だけ読み込めている", () => {
    expect(consumerSources.length).toBeGreaterThanOrEqual(30);
  });

  it("main.tsx からのモジュールグラフが UI の主要部分を含んでいる (グラフ構築の保険)", () => {
    expect(reachable.has(ENTRY)).toBe(true);
    expect(reachable.has("App.tsx")).toBe(true);
    // `lazy(() => import("./QueryEditor"))` のような動的 import もたどれている。
    expect(reachable.has("components/QueryEditor.tsx")).toBe(true);
    expect(reachableConsumers.length).toBeGreaterThanOrEqual(100);
  });

  it("UI から一度も呼ばれない api ラッパーが無い (main.tsx から到達するモジュールで判定)", () => {
    const unreachable = [...members]
      .filter((name) => !(name in INTENTIONALLY_UNREACHABLE))
      .filter((name) => referencedBy(name).length === 0)
      .sort();
    // 参照はあるが、それが main.tsx から到達しないモジュールだけにある (= 推移的デッドコード)
    // 場合は、どこで参照されているかを添えて原因を追えるようにする。
    const detail = unreachable
      .map((name) => {
        const dead = referencedBy(name, consumerSources);
        return dead.length > 0
          ? `${name} (到達しないモジュールからのみ参照: ${dead.join(", ")})`
          : name;
      })
      .join(", ");
    expect(
      unreachable,
      `UI から到達不能な api ラッパー (削除するか、理由を添えて INTENTIONALLY_UNREACHABLE へ): ${detail}`,
    ).toEqual([]);
  });

  it("許可リストが実態と合っている (到達可能になったエントリは外す)", () => {
    const stale = Object.keys(INTENTIONALLY_UNREACHABLE)
      .filter((name) => !members.has(name) || referencedBy(name).length > 0)
      .sort();
    expect(
      stale,
      `不要になった許可リストのエントリ: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * `main.tsx` から到達しなくてよいモジュールの許可リスト (#1421)。**空のまま維持するのが理想**。
 * 追加するときは「なぜアプリから読み込まれないのに残すのか」を必ず併記すること。
 */
const INTENTIONALLY_UNREACHABLE_MODULES: Record<string, string> = {};

describe("モジュール到達性 (main.tsx からの import グラフ, #1421)", () => {
  // knip はテストファイルもエントリに数えるため、テストからだけ import されるモジュールを
  // 「使われている」とみなす。UI の入口を外した機能のコンポーネント / ヘルパーは、
  // それぞれのテストが残っている限り knip を通過してしまう。ここでテスト以外の全モジュールが
  // アプリのエントリから実際にたどれることを要求して、推移的なデッドコードを検出する。
  it("テスト以外の全モジュールが main.tsx から到達できる", () => {
    const orphaned = consumerSources
      .map(([path]) => path)
      .filter((path) => !path.endsWith(".d.ts"))
      .filter((path) => !reachable.has(path))
      .filter((path) => !(path in INTENTIONALLY_UNREACHABLE_MODULES))
      .sort();
    expect(
      orphaned,
      `main.tsx から import でたどれないモジュール (UI の入口が外れた死蔵コードの可能性。削除するか、理由を添えて INTENTIONALLY_UNREACHABLE_MODULES へ): ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("許可リストが実態と合っている (到達可能になった / 消えたエントリは外す)", () => {
    const stale = Object.keys(INTENTIONALLY_UNREACHABLE_MODULES)
      .filter((path) => !(path in allSources) || reachable.has(path))
      .sort();
    expect(stale, `不要になった許可リストのエントリ: ${stale.join(", ")}`).toEqual(
      [],
    );
  });
});
