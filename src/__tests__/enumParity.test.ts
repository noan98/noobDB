import { describe, expect, it } from "vitest";
// `ipcCommandParity.test.ts` / `commandRegistrationParity.test.ts` と同じ
// `import.meta.glob` + `?raw` 方式で Rust ソースを読む。
import tauriTs from "../api/tauri.ts?raw";

const rustModules = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const rustSources = Object.values(rustModules);

// Rust の serde enum ⇔ フロントの string-literal union のバリアント完全性 (#1194)。
//
// Rust の enum を serde で文字列にして送り、フロントが同じ集合を union として手書き
// ミラーする型は、片側だけバリアントが増減しても `serde_schema_parity.rs` (代表
// インスタンスのみ) にも `advisor.test.ts` (ハードコード列挙) にも検出されない。
// ここでは Rust ソースの enum 定義からバリアント名を抽出して serde の `rename_all`
// 規則で線形名へ変換し、`src/api/tauri.ts` の union と**両方向で完全一致**させる
// (Rust→TS の欠落と TS→Rust の余剰の両方を検出する)。

type RenameRule = "snake_case" | "lowercase" | "camelCase" | "kebab-case";

/** `PascalCase` のバリアント名を serde の `rename_all` 規則で変換する。 */
function renameVariant(variant: string, rule: RenameRule): string {
  const words = variant.match(/[A-Z][a-z0-9]*/g) ?? [variant];
  switch (rule) {
    case "snake_case":
      return words.map((w) => w.toLowerCase()).join("_");
    case "kebab-case":
      return words.map((w) => w.toLowerCase()).join("-");
    case "lowercase":
      return variant.toLowerCase();
    case "camelCase":
      return variant.charAt(0).toLowerCase() + variant.slice(1);
  }
}

/** 行コメント (`//` / `///`) を除去する (doc コメント中の `enum X {` を誤検出しない)。 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Rust ソース全体から `pub enum <name> { ... }` を探し、直前の `#[serde(rename_all)]` に
 * 従った線形名の集合を返す。複数ファイルに同名 enum がある場合は曖昧なので失敗させる。
 */
function extractRustEnum(rustEnum: string): { rule: RenameRule; variants: string[] } {
  const found: { rule: RenameRule; variants: string[] }[] = [];
  const re = new RegExp(
    `((?:#\\[[^\\]]*\\]\\s*)*)pub\\s+enum\\s+${rustEnum}\\s*\\{([\\s\\S]*?)\\n\\}`,
    "g",
  );
  for (const raw of rustSources) {
    const src = stripLineComments(raw);
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const attrs = m[1];
      const ruleMatch = /rename_all\s*=\s*"([^"]+)"/.exec(attrs);
      if (!ruleMatch) throw new Error(`${rustEnum}: #[serde(rename_all)] が無い`);
      const rule = ruleMatch[1] as RenameRule;
      const body = m[2];
      // バリアントは `#[...]` 属性を除いた行頭の識別子 (タプル/構造体バリアントは未対応)。
      const variants: string[] = [];
      for (const line of body.replace(/#\[[^\]]*\]/g, "").split("\n")) {
        const v = /^\s*([A-Z][A-Za-z0-9]*)\s*(?:=[^,]*)?,?\s*$/.exec(line);
        if (v) variants.push(renameVariant(v[1], rule));
        else if (/^\s*[A-Z]/.test(line)) {
          throw new Error(`${rustEnum}: 未対応のバリアント形式 "${line.trim()}"`);
        }
      }
      found.push({ rule, variants });
    }
  }
  if (found.length !== 1) {
    throw new Error(`${rustEnum}: Rust 側の定義が ${found.length} 件見つかった (1 件のはず)`);
  }
  return found[0];
}

/** `src/api/tauri.ts` の `export type <name> = "a" | "b" ...;` からリテラル集合を返す。 */
function extractTsUnion(tsType: string): string[] {
  const re = new RegExp(`export\\s+type\\s+${tsType}\\s*=\\s*((?:\\|?\\s*"[^"]+"\\s*)+);`);
  const m = re.exec(stripBlockComments(tauriTs));
  if (!m) throw new Error(`${tsType}: tauri.ts に string-literal union が見つからない`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

// 対応表 (Rust enum 名 ⇔ TS union 名)。新しい serde enum をミラーしたらここへ足す。
const ENUM_PAIRS: { rust: string; ts: string }[] = [
  { rust: "RuleId", ts: "AdvisorRuleId" },
  { rust: "Severity", ts: "AdvisorSeverity" },
  { rust: "SyncKind", ts: "SyncKind" },
  { rust: "DriverKind", ts: "DriverKind" },
  { rust: "SslMode", ts: "SslMode" },
  { rust: "SshAuthMethod", ts: "SshAuthMethod" },
  { rust: "WriteKind", ts: "WriteKind" },
  { rust: "DiffStatus", ts: "DiffStatus" },
  { rust: "RowStatus", ts: "RowStatus" },
  { rust: "RowCountOp", ts: "RowCountOp" },
];

// 逃げ道の許可リスト (**空を維持するのが理想**)。意図的に片側しか持たない / 照合できない
// ペアだけを、根拠付きで載せる。
// - `RoutineParamMode`: Rust 側は enum ではなく文字列で返し (未知値は `in` に倒す)、TS は
//   `RoutineParamMode | string` で受けるため完全一致の対象外。
const ALLOWLIST: Record<string, string> = {};

describe("Rust serde enum ⇔ フロント union のバリアント完全性 (#1194)", () => {
  it("許可リストは空 (理想状態) か、根拠付きである", () => {
    for (const [name, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${name} の根拠が必要`).toBeGreaterThan(0);
    }
  });

  it("serde の rename 規則変換が期待どおり動く (抽出ロジックの自己検証)", () => {
    expect(renameVariant("FkMissingIndex", "snake_case")).toBe("fk_missing_index");
    expect(renameVariant("VerifyCa", "snake_case")).toBe("verify_ca");
    expect(renameVariant("Mysql", "lowercase")).toBe("mysql");
    expect(renameVariant("SourceOnly", "camelCase")).toBe("sourceOnly");
    expect(renameVariant("SourceOnly", "kebab-case")).toBe("source-only");
  });

  describe.each(ENUM_PAIRS.filter((p) => !(p.rust in ALLOWLIST)))(
    "$rust ⇔ $ts",
    ({ rust, ts }) => {
      const rustSide = extractRustEnum(rust).variants;
      const tsSide = extractTsUnion(ts);

      it("バリアントが 1 つ以上あり重複しない", () => {
        expect(rustSide.length).toBeGreaterThan(0);
        expect(new Set(rustSide).size).toBe(rustSide.length);
        expect(new Set(tsSide).size).toBe(tsSide.length);
      });

      it("Rust にあって TS union に無いバリアントが無い (フロントの欠落)", () => {
        const missing = rustSide.filter((v) => !tsSide.includes(v));
        expect(missing, `${ts} に追加が必要`).toEqual([]);
      });

      it("TS union にあって Rust に無いバリアントが無い (フロントの余剰)", () => {
        const extra = tsSide.filter((v) => !rustSide.includes(v));
        expect(extra, `${rust} に存在しない`).toEqual([]);
      });
    },
  );
});
