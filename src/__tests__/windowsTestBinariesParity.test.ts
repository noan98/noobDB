import { describe, expect, it } from "vitest";
import cargoToml from "../../src-tauri/Cargo.toml?raw";
import ciYml from "../../.github/workflows/ci.yml?raw";

// `rust (windows)` ジョブの `cargo nextest run --test <name>` の列挙を、`Cargo.toml` の `[[test]]`
// と突き合わせるメタテスト (#2412)。列挙は手書きで、コメント頼みで「[[test]] を足したらここにも足す」
// としているため、足し忘れたバイナリは Windows で一度も走らないまま緑になる。
// (`testWiringParity.test.ts` は tests/*.rs と [[test]] の結線だけを見る。)
// 命名規約 `*Parity.test.ts` により CI の `crosslang parity` ジョブで Rust のみの PR でも走る。

/** Windows のジョブで走らせない `[[test]]` (理由つき)。 */
const WINDOWS_EXCLUDED: Record<string, string> = {
  external: "実 DB / SSH / TLS が必要な統合テスト。環境変数を渡す `rust (test)` ジョブで全件実走する (#1511)",
};

/** `[[test]]` の `name` を列挙する。 */
function cargoTestNames(toml: string): string[] {
  const names: string[] = [];
  for (const block of toml.split(/^\[\[test\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\[/m)[0];
    const m = /^name\s*=\s*"([^"]+)"/m.exec(body);
    if (m) names.push(m[1]);
  }
  return names;
}

/** ci.yml の `rust-windows` ジョブ本文 (次のトップレベルジョブの手前まで)。 */
function windowsJobBlock(yml: string): string {
  const start = yml.search(/^ {2}rust-windows:\s*$/m);
  if (start < 0) return "";
  const rest = yml.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** ジョブ内のコメントを除いた `--test <name>` の集合 (`cargo nextest run` / `cargo test` の行)。 */
function windowsTestNames(block: string): string[] {
  const names = new Set<string>();
  for (const line of block.split("\n")) {
    const code = line.replace(/(^|\s)#.*$/, "");
    if (!/\bcargo\s+(?:nextest\s+run|test)\b/.test(code)) continue;
    for (const m of code.matchAll(/--test\s+([A-Za-z0-9_-]+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

describe("rust (windows) のテストバイナリ列挙 ⇔ Cargo.toml [[test]] (#2412)", () => {
  const declared = cargoTestNames(cargoToml);
  const block = windowsJobBlock(ciYml);
  const listed = windowsTestNames(block);

  it("検出ロジックが空振りしていない", () => {
    expect(declared).toContain("golden");
    expect(declared).toContain("integration");
    expect(block).toContain("rust (windows)");
    expect(listed).toContain("golden");
  });

  it("除外リストは実在の [[test]] で、理由がある", () => {
    for (const [name, reason] of Object.entries(WINDOWS_EXCLUDED)) {
      expect(declared, `${name} は Cargo.toml の [[test]] に無い`).toContain(name);
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("[[test]] (除外を除く) は rust (windows) の --test に全て入っている", () => {
    const missing = declared.filter((n) => !(n in WINDOWS_EXCLUDED) && !listed.includes(n));
    expect(
      missing,
      `ci.yml の rust-windows の cargo nextest run に --test を足すか、WINDOWS_EXCLUDED に理由つきで追加: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("rust (windows) の --test は実在する [[test]] だけ (リネーム・削除の取り残し)", () => {
    const stale = listed.filter((n) => !declared.includes(n));
    expect(stale, `Cargo.toml に無い --test: ${stale.join(", ")}`).toEqual([]);
  });

  it("除外したバイナリを rust (windows) が走らせていない (除外リストの陳腐化)", () => {
    const wrong = Object.keys(WINDOWS_EXCLUDED).filter((n) => listed.includes(n));
    expect(wrong, `除外リストから外すこと: ${wrong.join(", ")}`).toEqual([]);
  });
});
