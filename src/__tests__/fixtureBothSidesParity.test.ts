import { describe, expect, it } from "vitest";

// 共有ゴールデンフィクスチャ (`fixtures/*.json`) の「二側性」そのものを固定する
// メタテスト (#1177)。
//
// noobDB は「同一判定ロジックを 1 つの JSON で固定し、Rust とフロントの二重実装の
// ズレを検出する」方式を中核にしている。ところが各 fixture が実際に**両側から**
// 参照されているかを保証するテストは無く、新規 fixture で片側の golden を書き忘れたり、
// リファクタで片側の消費が消えたりすると、ドリフト保護が静かに失われる。ここでは
// fixture を列挙し、次の 2 点を assert する。
//   (a) `src-tauri/**/*.rs` に `include_str!(".../<file>")` が存在する
//   (b) `src/**/*.{ts,tsx}` (このファイル自身を除く) に当該 JSON の import が存在する
// `ipcCommandParity.test.ts` / `commandRegistrationParity.test.ts` と同じ
// `import.meta.glob` + `?raw` 方式 (ファイルが増えても追記漏れが起きない)。

const fixtureModules = import.meta.glob("./fixtures/*.json");
const fixtureFiles = Object.keys(fixtureModules).map((p) => p.replace("./fixtures/", ""));

const rustModules = import.meta.glob(
  ["../../src-tauri/src/**/*.rs", "../../src-tauri/tests/**/*.rs"],
  { eager: true, query: "?raw", import: "default" },
) as Record<string, string>;

const tsModules = import.meta.glob(["../**/*.ts", "../**/*.tsx"], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** 行コメント (`//` / `///` / `//!`) を除去する。コメント中の言及を参照と誤認しない。 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const rustSources = Object.values(rustModules).map(stripLineComments);
// このファイルは許可リストにファイル名を書くため、自分自身は参照元から除外する。
const tsSources = Object.entries(tsModules)
  .filter(([path]) => !path.endsWith("/fixtureBothSidesParity.test.ts"))
  .map(([, src]) => stripLineComments(src));

function hasRustInclude(file: string): boolean {
  const re = new RegExp(`include_str!\\(\\s*"[^"]*fixtures/${escapeRegExp(file)}"\\s*\\)`);
  return rustSources.some((src) => re.test(src));
}

function hasTsImport(file: string): boolean {
  // `import x from "./fixtures/a.json"` / `import("./fixtures/a.json")` /
  // `import x from "../__tests__/fixtures/a.json?raw"` を許容する。
  const re = new RegExp(`["'][^"']*fixtures/${escapeRegExp(file)}(?:\\?[a-z]+)?["']`);
  return tsSources.some((src) => re.test(src));
}

// 意図的に片側専用の fixture。**空を理想とする** (`apiReachabilityParity` と同じ思想)。
// 追加するときは「なぜ片側だけで足りるか」の根拠を必ずコメントで残すこと。
const RUST_ONLY: Record<string, string> = {
  // フロントに対応する実装が無い (自動 LIMIT 挿入はバックエンド専用, #990)。
  "autoLimitVectors.json": "自動 LIMIT 挿入はバックエンドのみ (#990)",
  // フロントに `is_query_shape` 相当の分類ロジックが無い (#971)。
  "queryShapeVectors.json": "実行経路の振り分けはバックエンドのみ (#971)",
  // フィンガープリント正規化は #1259 で JS から Rust へ移管済みでフロント実装が無い。
  "sqlFingerprintVectors.json": "正規化は Rust へ移管済み (#1259)",
};
const TS_ONLY: Record<string, string> = {};

describe("共有ゴールデンフィクスチャの二側性 (#1177)", () => {
  it("fixture を 1 つ以上列挙できている (glob の取りこぼし検出)", () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
    expect(Object.keys(rustModules).length).toBeGreaterThan(0);
    expect(Object.keys(tsModules).length).toBeGreaterThan(0);
  });

  it.each(fixtureFiles)("%s は Rust と フロントの両側から参照される", (file) => {
    const rust = hasRustInclude(file);
    const ts = hasTsImport(file);
    if (file in RUST_ONLY) {
      expect(rust, `${file}: Rust 専用のはずが include_str! が無い`).toBe(true);
      expect(ts, `${file}: Rust 専用リストにあるがフロントも参照している。リストから外す`).toBe(false);
    } else if (file in TS_ONLY) {
      expect(ts, `${file}: フロント専用のはずが import が無い`).toBe(true);
      expect(rust, `${file}: フロント専用リストにあるが Rust も参照している。リストから外す`).toBe(false);
    } else {
      expect(rust, `${file}: Rust 側の include_str! が見つからない (golden の書き忘れ?)`).toBe(true);
      expect(ts, `${file}: フロント側の import が見つからない (golden の書き忘れ?)`).toBe(true);
    }
  });

  it("許可リストに実在しない fixture が残っていない", () => {
    for (const file of [...Object.keys(RUST_ONLY), ...Object.keys(TS_ONLY)]) {
      expect(fixtureFiles, `${file} は存在しない fixture`).toContain(file);
    }
  });
});
