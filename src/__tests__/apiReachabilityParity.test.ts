import { describe, expect, it } from "vitest";
import { api } from "../api/tauri";

// API 到達性パリティ検証 (#907)。
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
// ここでは `tauri.ts` から `api` オブジェクトのプロパティ名を抽出し、`src/` 配下の
// **それ以外**のソースに `api.<name>` の参照があるかを走査する。参照が 1 つも無い
// ラッパーは「削除する」か「意図的な公開 API として許可リストへ入れる」かの
// どちらかを迫られる。

/**
 * `src/` 配下の全 TS/TSX を `?raw` で読み込む。`api/tauri.ts` 自身と、
 * このテストを含む `__tests__/` 配下は「UI からの到達性」の対象外
 * (テストが呼んでいるだけのラッパーは UI から到達できていない)。
 */
const allSources = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const consumerSources = Object.entries(allSources).filter(
  ([path]) => !path.includes("/api/tauri.ts") && !path.includes("/__tests__/"),
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
 */
function referencedBy(name: string): string[] {
  const re = new RegExp(`\\bapi\\s*\\.\\s*${name}\\b`);
  return consumerSources.filter(([, src]) => re.test(src)).map(([path]) => path);
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

  it("UI から一度も呼ばれない api ラッパーが無い", () => {
    const unreachable = [...members]
      .filter((name) => !(name in INTENTIONALLY_UNREACHABLE))
      .filter((name) => referencedBy(name).length === 0)
      .sort();
    expect(
      unreachable,
      `UI から到達不能な api ラッパー (削除するか、理由を添えて INTENTIONALLY_UNREACHABLE へ): ${unreachable.join(", ")}`,
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
