import { describe, expect, it } from "vitest";

// 外部 DB / SSH / クライアント前提の Rust 統合テストの skip を「require_env 経由」に固定する
// メタテスト (#2101)。
//
// 環境変数が無いときに `eprintln!("skip: ...")` して `return` する分岐を直書きすると、CI で
// DB の起動や環境変数の受け渡しが壊れても必須チェックが緑のまま、検証が実質止まる。
// skip は `tests/common/mod.rs` の `require_env` / `skip_external` (CI では
// `NOOBDB_TEST_REQUIRE_EXTERNAL=1` で panic) か、サーバ機能の有無による正当な
// `skip_capability` のどれかを通す。
//   (a) `tests/` 配下 (common を除く) に `eprintln!("skip` の直書きが無い
//   (b) `std::env::var("NOOBDB_TEST_*")` を直接読んで skip しない (`require_env` を使う)
//   (c) common の `skip_external` が `NOOBDB_TEST_REQUIRE_EXTERNAL` で panic する
//   (d) CI の external 実行ジョブがフラグを立てている
// 命名規約 `*Parity.test.ts` により CI の `crosslang parity` ジョブで Rust のみの PR でも走る。

const rustTests = import.meta.glob("../../src-tauri/tests/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const workflows = import.meta.glob("../../.github/workflows/*.yml", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const COMMON = "src-tauri/tests/common/mod.rs";
const rel = (p: string): string => p.replace("../../", "");
const entries = Object.entries(rustTests).map(([p, s]) => [rel(p), s] as const);

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("外部 DB 統合テストの skip は require_env 経由 (#2101)", () => {
  it("common/mod.rs と対象テストを読めている", () => {
    expect(entries.some(([p]) => p === COMMON)).toBe(true);
    expect(entries.some(([p]) => p.endsWith("mysql_integration.rs"))).toBe(true);
  });

  it('`eprintln!("skip` を common 以外に直書きしていない', () => {
    const offenders = entries
      .filter(([p]) => p !== COMMON)
      .filter(([, s]) => /eprintln!\(\s*"skip/.test(stripLineComments(s)))
      .map(([p]) => p);
    expect(offenders).toEqual([]);
  });

  it("NOOBDB_TEST_* の環境変数を直接読んで skip していない (require_env を使う)", () => {
    const re = /std::env::var\(\s*"NOOBDB_TEST_(?!REQUIRE_EXTERNAL|SKIP_LOG)\w+"\s*\)/;
    const offenders = entries
      .filter(([p]) => p !== COMMON)
      .filter(([, s]) => re.test(stripLineComments(s)))
      .map(([p]) => p);
    // tls / ssh は URL と CA を 1 組で読むヘルパ内で `.ok()?` を使う。skip 自体は
    // skip_external を通すので、ヘルパ内の直接読みだけを許可する。
    expect(offenders.sort()).toEqual([
      "src-tauri/tests/ssh_integration.rs",
      "src-tauri/tests/tls_integration.rs",
    ]);
  });

  it("skip_external は NOOBDB_TEST_REQUIRE_EXTERNAL で panic する", () => {
    const src = entries.find(([p]) => p === COMMON)?.[1] ?? "";
    expect(src).toMatch(/NOOBDB_TEST_REQUIRE_EXTERNAL/);
    expect(src).toMatch(/pub fn skip_external[\s\S]*?panic!/);
  });

  it("CI の external 実行ジョブ (nextest / coverage / windows db smoke) がフラグを立てている", () => {
    const ci = Object.entries(workflows).find(([p]) => p.endsWith("/ci.yml"))?.[1] ?? "";
    const smoke = Object.entries(workflows).find(([p]) => p.endsWith("/windows-db-smoke.yml"))?.[1] ?? "";
    const flag = /NOOBDB_TEST_REQUIRE_EXTERNAL:\s*"1"/g;
    // rust (test) と rust (coverage) の 2 か所。
    expect((ci.match(flag) ?? []).length).toBe(2);
    expect((smoke.match(flag) ?? []).length).toBe(1);
  });
});
