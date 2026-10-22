import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// `ipcCommandParity.test.ts` / `commandRegistrationParity.test.ts` と同じ
// `import.meta.glob` + `?raw` 方式で Rust / TS ソースを読む。
const rustModules = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const tsModules = import.meta.glob("../api/tauri.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
// IPC 境界を越える serde enum は tauri.ts の外 (`txOptions.ts` / `components/*.ts` など) でも
// ミラーされる。それらは「Rust 側に対応する serde enum がある union」だけを拾う (#1759)。
// 約 350 ファイル・3.6MB を `import.meta.glob("?raw")` で束ねると Vite の変換だけで数秒かかる
// ので、こちらは fs で直接読む。
const srcRoot = fileURLToPath(new URL("..", import.meta.url));
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : listSourceFiles(full);
    const ok = e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts");
    return ok && full !== join(srcRoot, "api", "tauri.ts") ? [full] : [];
  });
}
const otherTsModules: Record<string, string> = {};
for (const f of listSourceFiles(srcRoot)) otherTsModules[f] = readFileSync(f, "utf8");

// Rust の serde enum ⇔ フロントの union のバリアント完全性 (#1194 / #1759)。
//
// Rust の enum を serde で文字列にして送り、フロントが同じ集合を union として手書き
// ミラーする型は、片側だけバリアントが増減しても `serde_schema_parity.rs` (代表
// インスタンスのみ) にも `advisor.test.ts` (ハードコード列挙) にも検出されない。
// ここでは Rust ソースの enum 定義からバリアント名を抽出して serde の `rename_all` /
// 個別 `rename` 規則で線形名へ変換し、TS の union と**両方向で完全一致**させる
// (Rust→TS の欠落と TS→Rust の余剰の両方を検出する)。
//
// 対象は手書きの対応表ではなく **glob 全件** (#1759): IPC 境界の型定義 `src/api/tauri.ts` の
// `export type` のうち (`src/ai/*.ts` の union はフロント内部専用で、AI 系 enum は
// `aiParity.test.ts` が別途照合する)、
//   - 文字列リテラルだけの union (`"a" | "b"`)
//   - 全メンバーが同じ判別子フィールドを持つオブジェクト union (`{ kind: "a"; ... } | ...`)
// を機械的に拾い、**すべてが次のどれかに分類されている**ことを強制する:
//
//   - 自動 COVERED : 同名の Rust enum がある (名前が違うものは `NAME_MAP` に明示)
//   - `EXCLUDED`   : Rust 側に serde enum が無い / 照合できない型 (理由つき・最小限)
//
// tauri.ts 以外の `src/**/*.ts` (テスト除く) は 2 段目: 同名 (または `NAME_MAP`) で、かつ Rust 側が
// serde derive 付きの enum である union だけを自動で照合し、それ以外 (フロント内部専用の型や
// 無関係な同名 enum) は黙ってスキップする。同名の union が複数ファイルにあるものも対象外。
//
// 新しい union を足したのにどちらにも当てはまらないとここで落ちる。同名の Rust enum が
// あれば自動で照合されるので、追記を忘れて素通りすることがない。

type RenameRule =
  | "snake_case"
  | "lowercase"
  | "camelCase"
  | "kebab-case"
  | "PascalCase"
  | "SCREAMING_SNAKE_CASE";
const RENAME_RULES: readonly string[] = [
  "snake_case",
  "lowercase",
  "camelCase",
  "kebab-case",
  "PascalCase",
  "SCREAMING_SNAKE_CASE",
];

/** `PascalCase` のバリアント名を serde の `rename_all` 規則で変換する。 */
function renameVariant(variant: string, rule: RenameRule | null): string {
  const words = variant.match(/[A-Z][a-z0-9]*/g) ?? [variant];
  switch (rule) {
    case null:
    case "PascalCase":
      return variant;
    case "snake_case":
      return words.map((w) => w.toLowerCase()).join("_");
    case "SCREAMING_SNAKE_CASE":
      return words.map((w) => w.toUpperCase()).join("_");
    case "kebab-case":
      return words.map((w) => w.toLowerCase()).join("-");
    case "lowercase":
      return variant.toLowerCase();
    case "camelCase":
      return variant.charAt(0).toLowerCase() + variant.slice(1);
  }
}

/** 行コメント (`//` / `///`) を除去する (doc コメント中の `enum X {` を誤検出しない)。 */
function stripRustComments(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** `open` の位置にある括弧に対応する閉じ括弧の位置を返す。 */
function matchingClose(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error("括弧が閉じていない");
}

/** 括弧 (`{ ( [`) の外側にある `sep` で分割する。 */
function splitTopLevel(src: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"')
      i = src.indexOf('"', i + 1); // 文字列リテラル内の区切りは無視する
    else if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

interface RustEnum {
  file: string;
  /** `#[serde(tag = "...")]` の内部タグ名。無ければ null。 */
  tag: string | null;
  variants: string[];
}

/** 1 つの enum 定義 (属性文字列と本体) から serde 上の線形名を取り出す。 */
function parseRustEnum(attrs: string, body: string, file: string, label: string): RustEnum {
  const ruleMatch = /\brename_all\s*=\s*"([^"]+)"/.exec(attrs);
  if (ruleMatch && !RENAME_RULES.includes(ruleMatch[1])) {
    throw new Error(`${label}: 未対応の rename_all "${ruleMatch[1]}"`);
  }
  const rule = (ruleMatch?.[1] ?? null) as RenameRule | null;
  const tag = /\btag\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? null;
  const variants: string[] = [];
  for (const chunk of splitTopLevel(body, ",")) {
    // 先頭の `#[...]` 属性群を集めてから識別子を読む (構造体/タプルバリアントも先頭だけ見る)。
    let rest = chunk.trim();
    let variantAttrs = "";
    for (let a = /^#\[[^\]]*\]\s*/.exec(rest); a; a = /^#\[[^\]]*\]\s*/.exec(rest)) {
      variantAttrs += a[0];
      rest = rest.slice(a[0].length);
    }
    if (rest === "") continue;
    const id = /^([A-Z][A-Za-z0-9]*)\b/.exec(rest);
    if (!id) throw new Error(`${label}: 未対応のバリアント形式 "${rest.slice(0, 40)}"`);
    if (/\bserde\([^)]*\bskip\b/.test(variantAttrs)) continue;
    const renamed = /\bserde\([^)]*\brename\s*=\s*"([^"]+)"/.exec(variantAttrs)?.[1];
    variants.push(renamed ?? renameVariant(id[1], rule));
  }
  return { file, tag, variants };
}

/** 全 Rust ソースから `enum <name> { ... }` の定義をすべて集める (`pub` / `pub(crate)` / 非公開)。 */
function findRustEnums(name: string, sources: Record<string, string> = rustModules): RustEnum[] {
  // serde の `Serialize` / `Deserialize` を derive していない同名 enum (内部専用) は IPC に流れないので除く。
  const found: RustEnum[] = [];
  const head = new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*)(?:pub(?:\\([^)]*\\))?\\s+)?enum\\s+${name}\\s*\\{`, "g");
  const cheap = new RegExp(`\\benum\\s+${name}\\b`);
  for (const [file, raw] of Object.entries(sources)) {
    // 全ファイルのコメント除去は重いので、候補になりそうなファイルだけ処理する。
    if (!cheap.test(raw)) continue;
    const src = stripRustComments(raw);
    head.lastIndex = 0;
    for (let m = head.exec(src); m !== null; m = head.exec(src)) {
      if (!/\b(?:Serialize|Deserialize)\b/.test(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const close = matchingClose(src, open);
      found.push(parseRustEnum(m[1], src.slice(open + 1, close), file, name));
    }
  }
  return found;
}

/** 文字列リテラル・コメントを意識して TS のコメントを除去する。 */
function stripTsComments(src: string): string {
  return src.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_m, str: string | undefined) => str ?? "",
  );
}

type TsUnion = { kind: "string"; variants: string[] } | { kind: "tagged"; tag: string; variants: string[] };

/** `{ ... }` オブジェクト型メンバーの直下フィールドのうち、文字列リテラル型のものを返す。 */
function literalFields(member: string): Map<string, string> {
  const inner = member.trim().slice(1, -1);
  const fields = new Map<string, string>();
  for (const f of splitTopLevel(inner.replace(/,/g, ";"), ";")) {
    const m = /^\s*(\w+)\s*:\s*"([^"]*)"\s*$/.exec(f);
    if (m) fields.set(m[1], m[2]);
  }
  return fields;
}

/** `export type X = ...;` の右辺が string union / 判別子付き union ならそれを返す。 */
function classifyTsUnion(rhs: string): TsUnion | null {
  const members = splitTopLevel(rhs, "|")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (members.length === 0) return null;
  if (members.every((m) => /^"[^"]*"$/.test(m))) {
    return { kind: "string", variants: members.map((m) => m.slice(1, -1)) };
  }
  if (members.every((m) => m.startsWith("{") && m.endsWith("}"))) {
    const fields = members.map(literalFields);
    const tag = [...fields[0].keys()].find((k) => fields.every((f) => f.has(k)));
    if (tag !== undefined) {
      return { kind: "tagged", tag, variants: fields.map((f) => f.get(tag) as string) };
    }
  }
  return null;
}

/** ソース中の `export type <name> = ...;` をすべて走査し、対象になる union だけ返す。 */
function extractTsUnions(raw: string, unclassified?: string[]): Map<string, TsUnion> {
  const src = stripTsComments(raw);
  const out = new Map<string, TsUnion>();
  const head = /export\s+type\s+(\w+)\s*=/g;
  for (let m = head.exec(src); m !== null; m = head.exec(src)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let end = start;
    for (; end < src.length; end++) {
      const c = src[end];
      if (c === '"') end = src.indexOf('"', end + 1);
      else if (c === "{" || c === "(" || c === "[") depth++;
      else if (c === "}" || c === ")" || c === "]") depth--;
      else if (c === ";" && depth === 0) break;
    }
    const rhs = src.slice(start, end);
    const u = classifyTsUnion(rhs);
    if (u) out.set(m[1], u);
    else if (unclassified && /"[^"]*"/.test(rhs)) unclassified.push(m[1]);
  }
  return out;
}

/** glob で拾った全 TS ファイルの対象 union (名前 → 定義)。 */
const tsUnions = new Map<string, TsUnion>();
/** 文字列リテラルを含むのに string union / 判別子付き union として拾えなかった型 (tauri.ts)。 */
const unclassifiedTs: string[] = [];
for (const [file, raw] of Object.entries(tsModules)) {
  for (const [name, union] of extractTsUnions(raw, unclassifiedTs)) {
    if (tsUnions.has(name)) throw new Error(`${name}: TS 側の union が複数ファイルにある (${file})`);
    tsUnions.set(name, union);
  }
}

/** tauri.ts 以外の union (名前 → 定義)。同名が複数ファイルにあるものは null (曖昧なのでスキップ)。 */
const otherUnions = new Map<string, TsUnion | null>();
for (const raw of Object.values(otherTsModules)) {
  // union の候補 (右辺が文字列リテラルか `{` で始まる) を含むファイルだけ処理する。
  if (!/export\s+type\s+\w+\s*=\s*(?:\|\s*)?["{]/.test(raw)) continue;
  for (const [name, union] of extractTsUnions(raw)) {
    otherUnions.set(name, otherUnions.has(name) ? null : union);
  }
}

// TS union 名 → Rust enum 名。**名前が違うものだけ**書く (同名は自動で照合される)。
const NAME_MAP: Record<string, string> = {
  AdvisorRuleId: "RuleId",
  AdvisorSeverity: "Severity",
  ImportConflictMode: "ConflictMode",
  ProfileImportStrategy: "ImportStrategy",
  ProfileSecretKind: "SecretKind",
  QueryStreamPatchRun: "PatchRun",
  ScriptDangerKind: "DangerKind",
  TextEncodingId: "TextEncoding",
  TransferLossyKind: "LossyKind",
  TransferTypeKind: "OverrideKind",
  // tauri.ts 以外のミラー (components/exportMasking.ts)。
  FilterNullMode: "NullMode",
  ExportMaskRule: "MaskRule",
  ExportMaskDatePrecision: "DatePrecision",
};

// tauri.ts 以外で、たまたま Rust の serde enum と同名なだけの無関係な union (自動照合から外す)。
const OTHER_NOT_MIRRORS: Record<string, string> = {
  NullMode:
    "`components/importTemplate.ts` のインポート用 NULL 扱い (none/empty/custom)。Rust の `NullMode` (result_ops.rs, 結果のフィルタ用) とは別物で、ミラーは `FilterNullMode`。",
};

// 文字列リテラルを含むが string union / 判別子付き union ではない tauri.ts の型 (照合対象外)。
// 新しく増えたらここへ理由付きで足すか、照合できる形にする。
const NON_UNION_LITERAL_TYPES: Record<string, string> = {};

// 逃げ道の許可リスト (**空を維持するのが理想**)。Rust 側に serde enum が無い / 完全一致で
// 照合できない union だけを、根拠付きで載せる。
const EXCLUDED: Record<string, string> = {
  RoutineParamMode:
    "Rust 側は enum ではなく文字列で返し (未知値は `in` に倒す)、TS は `RoutineParamMode | string` で受けるため完全一致の対象外。",
  SchemaObjectKind:
    "Rust の `SchemaObject.kind` は `String` (DB のカタログ値をそのまま運ぶ) で enum が無い。値の集合は `where_used.rs` / `object_search.rs` の文字列比較側で守られる。",
  DumpToolName:
    "Rust の `DumpTool` は serde ではなく `parse()` / `binary()` の手書き文字列対応で、IPC には文字列のまま流れる (`DumpToolStatus.tool: String`)。serde 名の照合対象外。",
};

/** TS union 名に対応する Rust enum 名。対応が無ければ null。 */
function rustNameFor(ts: string): string | null {
  if (ts in NAME_MAP) return NAME_MAP[ts];
  return findRustEnums(ts).length > 0 ? ts : null;
}

const covered = [...tsUnions.keys()].filter((n) => !(n in EXCLUDED));

/** tauri.ts 以外で、serde derive 付きの Rust enum と対応する union (自動 COVERED)。 */
const otherCovered = [...otherUnions.entries()]
  .filter(([n, u]) => u !== null && !tsUnions.has(n) && !(n in OTHER_NOT_MIRRORS) && rustNameFor(n) !== null)
  .map(([n]) => n);
/** 照合に使う union 定義 (tauri.ts を優先)。 */
function unionOf(name: string): TsUnion | undefined {
  return tsUnions.get(name) ?? otherUnions.get(name) ?? undefined;
}

describe("Rust serde enum ⇔ フロント union のバリアント完全性 (#1194 / #1759)", () => {
  it("serde の rename 規則変換が期待どおり動く (抽出ロジックの自己検証)", () => {
    expect(renameVariant("FkMissingIndex", "snake_case")).toBe("fk_missing_index");
    expect(renameVariant("VerifyCa", "snake_case")).toBe("verify_ca");
    expect(renameVariant("Mysql", "lowercase")).toBe("mysql");
    expect(renameVariant("SourceOnly", "camelCase")).toBe("sourceOnly");
    expect(renameVariant("SourceOnly", "kebab-case")).toBe("source-only");
    expect(renameVariant("NoHit", "SCREAMING_SNAKE_CASE")).toBe("NO_HIT");
    expect(renameVariant("NoHit", null)).toBe("NoHit");
  });

  it("Rust enum 抽出が個別 rename・タグ・構造体バリアント・属性を扱える (自己検証)", () => {
    const sources = {
      a: [
        "/// doc `pub enum Fake {`",
        '#[derive(Debug, Serialize)]\n#[serde(tag = "kind", rename_all = "snake_case")]',
        "pub enum Fake {",
        "    /// 説明",
        "    #[default]",
        "    NoHit,",
        "    Rows { prev: Vec<Option<u32>>, rows: Vec<Vec<Value>> },",
        '    #[serde(rename = "x-y")]',
        "    Special(String),",
        "    #[serde(skip)]",
        "    Hidden,",
        "}",
      ].join("\n"),
    };
    const [e] = findRustEnums("Fake", sources);
    expect(e.tag).toBe("kind");
    expect(e.variants).toEqual(["no_hit", "rows", "x-y"]);
  });

  it("TS union 抽出が string union と判別子付き union を拾い、それ以外は拾わない (自己検証)", () => {
    const u = extractTsUnions(
      [
        '/** doc: export type Fake = "z"; */',
        'export type A = "a" | "b";',
        "export type B =",
        '  | { kind: "x"; n: number; nested: { kind: "ignored" } }',
        '  | { kind: "y" }; // 末尾コメント',
        'export type C = { status: "hit"; reason: "p" | "q" } | { status: "no-hit" };',
        "export type D = number | string;",
        'export type E = { a: "x" } | { b: "y" };',
        'export type F = "semi;colon" | "pipe|bar";',
      ].join("\n"),
    );
    expect(u.get("A")).toEqual({ kind: "string", variants: ["a", "b"] });
    expect(u.get("B")).toEqual({ kind: "tagged", tag: "kind", variants: ["x", "y"] });
    expect(u.get("C")).toEqual({ kind: "tagged", tag: "status", variants: ["hit", "no-hit"] });
    expect(u.has("D")).toBe(false);
    expect(u.has("E")).toBe(false);
    expect(u.get("F")).toEqual({ kind: "string", variants: ["semi;colon", "pipe|bar"] });
    expect(u.has("Fake")).toBe(false);
  });

  it("glob で union を十分な件数拾えている (抽出が壊れて 0 件になっても green にしない)", () => {
    expect(tsUnions.size).toBeGreaterThan(30);
    // #1759 で取り込んだ、これまで未保護だった型と内部タグ付き union が対象に入っている。
    for (const n of [
      "ServerMessageSeverity",
      "SqliteMaintenanceAction",
      "AutoLimitSkip",
      "TaskAction",
      "TaskSchedule",
      "AssertionRule",
      "SnippetScope",
      "DataSearchEntry",
    ]) {
      expect(covered, `${n} が対象に入っていない`).toContain(n);
    }
    expect(tsUnions.get("TaskSchedule")?.kind).toBe("tagged");
    expect(tsUnions.get("AutoLimitSkip")?.kind).toBe("string");
  });

  it("すべての TS union が COVERED (同名 / NAME_MAP) か EXCLUDED のどれかに分類されている", () => {
    const unclassified = covered.filter((n) => rustNameFor(n) === null);
    expect(
      unclassified,
      "対応する Rust の serde enum が無い union。Rust 側の名前が違うなら NAME_MAP に、Rust に enum が無いなら理由付きで EXCLUDED に足す",
    ).toEqual([]);
  });

  it("EXCLUDED は根拠付きで、実在する union だけを指し、実は照合できる型を隠していない", () => {
    for (const [name, reason] of Object.entries(EXCLUDED)) {
      expect(reason.length, `${name} の根拠が必要`).toBeGreaterThan(0);
      expect(tsUnions.has(name), `${name} は TS に無い (EXCLUDED が古い)`).toBe(true);
      expect(name in NAME_MAP, `${name} は NAME_MAP にもある (どちらかを消す)`).toBe(false);
      expect(findRustEnums(name), `${name} は同名の Rust enum があるので EXCLUDED にできない`).toEqual([]);
    }
  });

  it("NAME_MAP は実在する union と Rust enum だけを結び、同名で自動照合できるものを含まない", () => {
    for (const [ts, rust] of Object.entries(NAME_MAP)) {
      expect(unionOf(ts), `${ts} は TS に無い (NAME_MAP が古い)`).toBeDefined();
      expect(findRustEnums(rust).length, `${rust} は Rust に無い (NAME_MAP が古い)`).toBeGreaterThan(0);
      expect(ts === rust, `${ts} は同名なので NAME_MAP は不要`).toBe(false);
    }
  });

  it("OTHER_NOT_MIRRORS は根拠付きで、実在する union だけを指す", () => {
    for (const [n, reason] of Object.entries(OTHER_NOT_MIRRORS)) {
      expect(reason.length, `${n} の根拠が必要`).toBeGreaterThan(0);
      expect(otherUnions.get(n), `${n} は tauri.ts 以外に無い (許可リストが古い)`).toBeTruthy();
    }
  });

  it("tauri.ts 以外のミラー (TxIsolation / SqlConflictMode / PlanChangeKind / MatchMode / BulkSetValue 等) も対象に入っている", () => {
    for (const n of [
      "TxIsolation",
      "SqlConflictMode",
      "PlanChangeKind",
      "PlanChangeSeverity",
      "MatchMode",
      "BulkSetValue",
      "ExportMaskRule",
      "ExportMaskDatePrecision",
    ]) {
      expect([...covered, ...otherCovered], `${n} が対象に入っていない`).toContain(n);
    }
  });

  it("文字列リテラルを含む tauri.ts の型は、拾えたか許可リストに理由付きで載っている", () => {
    const stray = unclassifiedTs.filter((n) => !(n in NON_UNION_LITERAL_TYPES));
    expect(
      stray,
      "string union / 判別子付き union として拾えない型。形を直すか NON_UNION_LITERAL_TYPES に理由付きで足す",
    ).toEqual([]);
    for (const [n, reason] of Object.entries(NON_UNION_LITERAL_TYPES)) {
      expect(reason.length, `${n} の根拠が必要`).toBeGreaterThan(0);
      expect(unclassifiedTs, `${n} はもう該当しない (許可リストが古い)`).toContain(n);
    }
  });

  // 未分類 (Rust に対応が無い) union は上のテストが報告するので、ここでは除外して空 suite を作らない。
  describe.each([...covered, ...otherCovered].filter((n) => rustNameFor(n) !== null).map((ts) => [ts]))(
    "%s",
    (ts) => {
      const rust = rustNameFor(ts) as string;
      const union = unionOf(ts) as TsUnion;
      const defs = findRustEnums(rust);

      it(`${rust} ⇔ ${ts}: Rust 側の定義がちょうど 1 件`, () => {
        expect(defs.length, `${rust}: Rust 側の定義が ${defs.length} 件 (1 件のはず)`).toBe(1);
      });

      const def = defs[0];
      if (!def) return;
      const rustSide = def.variants;
      const tsSide = union.variants;

      it("バリアントが 1 つ以上あり重複しない", () => {
        expect(rustSide.length).toBeGreaterThan(0);
        expect(new Set(rustSide).size).toBe(rustSide.length);
        expect(new Set(tsSide).size).toBe(tsSide.length);
      });

      it("判別子の形が一致する (string union ⇔ タグ無し / tagged union ⇔ 同名タグ)", () => {
        if (union.kind === "tagged") {
          expect(def.tag, `${rust} に #[serde(tag = "${union.tag}")] が必要`).toBe(union.tag);
        } else {
          expect(def.tag, `${ts} は string union だが ${rust} は内部タグ付き`).toBeNull();
        }
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
