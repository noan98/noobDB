import { describe, expect, it } from "vitest";
import schemasTs from "../api/schemas.ts?raw";
import { apiWrapperSource } from "./apiSources";

// Tauri `Channel<T>` メッセージ enum のバリアント完全性パリティ (#1772)。
//
// `run_query_stream` 等はストリーム結果を名前付き emit ではなく `kind` タグ付きの
// `Channel<T>` メッセージで返す (#1096)。このメッセージ enum は次のどのパリティにも
// 入らず、取り残されていた:
//
//   - `serdeCoverageParity.test.ts` : `#[tauri::command]` の**戻り値型**だけが対象
//     (Channel は `on_event: Channel<T>` という**引数**型)。
//   - `enumParity.test.ts`          : string-literal union 専用 (内部タグ enum は対象外)。
//   - `streamEventParity.test.ts`   : 名前付きイベント (emit / listen) 専用。
//
// 一方フロントは `tauri.ts` の `switch (msg.kind)` で手書きミラーし、`default:` は未知の
// kind を黙って無視する。Rust が新バリアントを足しても CI が 1 本も落ちずに機能が静かに
// 欠落する。ここでは `Channel<T>` に使われる内部タグ enum を Rust ソースから機械的に
// 抽出し、serde のリネーム規則で `kind` 値へ線形化したうえで、次を両方向で強制する:
//
//   1. Rust の kind 集合 == 対応する `listenXxx` の `switch (msg.kind)` の case 集合
//   2. 各 case が検証に使う Zod スキーマ (`schemas.xxx`) の `kind` リテラルが case と一致し、
//      その和集合 == Rust の kind 集合 (スキーマ側の取りこぼし / 余剰を検出)
//
// 抽出元は `commandRegistrationParity` / `serdeCoverageParity` と同じ `import.meta.glob` +
// `?raw` 方式 (コマンドモジュール追加時の追記漏れを構造的に無くす)。

const commandModules = import.meta.glob("../../src-tauri/src/commands/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/**
 * Channel メッセージ enum 名 → フロントの購読関数名。新しい Channel enum を足したら
 * ここへ必ず追記する (未登録なら下のテストが落ちる)。除外は原則禁止 (許可リストは空を維持)。
 */
const LISTENERS: Record<string, string> = {
  AiStreamMessage: "listenAiStream",
  BatchStreamMessage: "listenBatchStream",
  BroadcastMessage: "listenBroadcast",
  DataSearchMessage: "listenDataSearchStream",
  PreviewStreamMessage: "listenPreviewStream",
  QueryStreamMessage: "listenQueryStream",
  WhereUsedMessage: "listenWhereUsedStream",
};

// ---------------------------------------------------------------------------
// 抽出ロジック (純関数。合成入力でのネガティブテストからも呼ぶ)
// ---------------------------------------------------------------------------

function stripRustComments(src: string): string {
  // 文字列リテラル内の `//` を誤ってコメント扱いしないよう、先にリテラルの中身を空にする。
  // (`rename = "x"` のような属性値は後段で読むので、ここでは壊さず退避する。)
  const strings: string[] = [];
  const masked = src.replace(/"(?:[^"\\\n]|\\.)*"/g, (lit) => {
    strings.push(lit);
    return `"\u0000${strings.length - 1}\u0000"`;
  });
  const stripped = masked.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return stripped.replace(/"\u0000(\d+)\u0000"/g, (_, i) => strings[Number(i)]);
}

/** serde の `rename_all` 規則を PascalCase のバリアント名へ適用する。 */
function applyRename(variant: string, rule: string | undefined): string {
  const words = variant.match(/[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [variant];
  switch (rule) {
    case undefined:
      return variant;
    case "camelCase":
      return variant.charAt(0).toLowerCase() + variant.slice(1);
    case "lowercase":
      return variant.toLowerCase();
    case "snake_case":
      return words.map((w) => w.toLowerCase()).join("_");
    case "kebab-case":
      return words.map((w) => w.toLowerCase()).join("-");
    case "PascalCase":
      return variant;
    default:
      throw new Error(
        `未対応の serde rename_all 規則: ${rule} (channelMessageParity の applyRename を拡張してください)`,
      );
  }
}

interface ChannelEnum {
  tag?: string;
  kinds: string[];
  /** ペイロードを持たないバリアントの kind (`Done {}` / 単位バリアント)。検証すべき中身が無い。 */
  emptyKinds: string[];
}

/** `Channel<` 直後から `<>` の釣り合う範囲を型引数として取り出す。 */
function channelTypeArgs(params: string): string[] {
  const out: string[] = [];
  for (const m of params.matchAll(/\bChannel\s*</g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < params.length && depth > 0; i++) {
      if (params[i] === "<") depth++;
      else if (params[i] === ">") depth--;
    }
    out.push(params.slice(start, i - 1).trim());
  }
  return out;
}

/**
 * `#[tauri::command]` の引数で `Channel<T>` に使われている型名を集める。パス付き
 * (`super::x::Msg`) は先頭のパスを落として解決し、それでも単純な識別子にならない型
 * (ジェネリクスなど) は `unresolved` に積む (黙って捨てない)。
 */
function extractChannelTypeNames(sources: string[]): { names: Set<string>; unresolved: string[] } {
  const re =
    /#\[tauri::command(?:\([^)]*\))?\](?:\s*#\[[^\]]*\])*\s*(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*(?:<[^>]*>)?\s*(\([\s\S]*?\))\s*(?:->[\s\S]*?)?\s*(?:where[^{]*)?\{/g;
  const names = new Set<string>();
  const unresolved: string[] = [];
  for (const src of sources) {
    const cleaned = stripRustComments(src);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      for (const arg of channelTypeArgs(m[1])) {
        const bare = arg.replace(/^(?:\w+::)*/, "");
        if (/^\w+$/.test(bare)) names.add(bare);
        else unresolved.push(`Channel<${arg}>`);
      }
    }
  }
  return { names, unresolved };
}

/** 全 enum を抽出する。タグ無し (外部タグ / untagged) の enum は `tag` が undefined。 */
function extractEnums(sources: string[]): { enums: Map<string, ChannelEnum>; duplicates: string[] } {
  const enums = new Map<string, ChannelEnum>();
  const duplicates: string[] = [];
  const re = /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)\s*(?:<[^{]*>)?\s*(?:where[^{]*)?\{/g;
  for (const src of sources) {
    const cleaned = stripRustComments(src);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const attrs = m[1];
      const generic = /enum\s+\w+\s*</.test(m[0]);
      const tag = /\btag\s*=\s*"(\w+)"/.exec(attrs)?.[1];
      const untagged = /\buntagged\b/.test(attrs);
      const rule = /\brename_all\s*=\s*"([\w-]+)"/.exec(attrs)?.[1];
      // 本体 (波括弧の釣り合う範囲)。
      let depth = 1;
      let i = re.lastIndex;
      const start = i;
      for (; i < cleaned.length && depth > 0; i++) {
        if (cleaned[i] === "{") depth++;
        else if (cleaned[i] === "}") depth--;
      }
      const body = cleaned.slice(start, i - 1);
      const kinds: string[] = [];
      const emptyKinds: string[] = [];
      let seg = "";
      let d = 0;
      const flush = () => {
        const t = seg.trim();
        seg = "";
        if (!t) return;
        const name = /^((?:#\[[^\]]*\]\s*)*)([A-Z]\w*)/.exec(t);
        if (!name) throw new Error(`enum ${m?.[2]} のバリアントを解釈できません: ${t.slice(0, 40)}`);
        const variantAttrs = name[1];
        // 出力されないバリアントは kind を持たない。
        if (/#\[\s*serde\s*\([^\]]*\bskip(?:_serializing)?\b(?!_)/.test(variantAttrs)) return;
        const renamed = /#\[\s*serde\s*\([^\]]*\brename\s*=\s*"([^"]+)"/.exec(variantAttrs)?.[1];
        const kind = renamed ?? applyRename(name[2], rule);
        kinds.push(kind);
        const after = t.slice(name[0].length).replace(/\s+/g, "");
        if (after === "" || after === "{}" || after === "()") emptyKinds.push(kind);
      };
      for (const ch of body) {
        if (ch === "{" || ch === "(" || ch === "[") d++;
        else if (ch === "}" || ch === ")" || ch === "]") d--;
        if (ch === "," && d === 0) flush();
        else seg += ch;
      }
      flush();
      if (enums.has(m[2])) duplicates.push(m[2]);
      enums.set(m[2], {
        tag: tag && !untagged && !generic ? tag : undefined,
        kinds,
        emptyKinds,
      });
    }
  }
  return { enums, duplicates };
}

/**
 * `Channel<T>` に使われる内部タグ enum (名前 → 定義)。enum 定義は `commands/` 外にも
 * ありうるので、定義側は渡された全ソースから探す。解決できないものは `unresolved`。
 */
function extractChannelEnums(
  commandSources: string[],
  allSources: string[] = commandSources,
): { enums: Map<string, ChannelEnum & { tag: string }>; unresolved: string[]; duplicates: string[] } {
  const { names, unresolved } = extractChannelTypeNames(commandSources);
  const { enums: all, duplicates } = extractEnums(allSources);
  const out = new Map<string, ChannelEnum & { tag: string }>();
  const problems = [...unresolved];
  for (const name of names) {
    const def = all.get(name);
    if (!def) problems.push(`${name} (enum 定義が見つからない)`);
    else if (!def.tag) problems.push(`${name} (内部タグ enum ではない / ジェネリック)`);
    else out.set(name, { ...def, tag: def.tag });
  }
  return { enums: out, unresolved: problems, duplicates: duplicates.filter((d) => names.has(d)) };
}

interface SwitchCase {
  kind: string;
  schemas: string[];
}

/** 関数 `fnName` の `switch (msg.kind)` の case と、各 case が使う `schemas.xxx` を返す。 */
function extractSwitchCases(source: string, fnName: string): SwitchCase[] | null {
  const start = source.search(new RegExp(`function\\s+${fnName}\\b`));
  if (start < 0) return null;
  const rest = source.slice(start + 1);
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s/);
  const fn = next < 0 ? rest : rest.slice(0, next);
  const sw = fn.indexOf("switch (msg.kind)");
  if (sw < 0) return null;
  const parts = fn.slice(sw).split(/\n\s*(?=case "|default:)/);
  const cases: SwitchCase[] = [];
  for (const part of parts) {
    const m = /^case "([^"]+)":([\s\S]*)$/.exec(part);
    if (!m) continue;
    cases.push({
      kind: m[1],
      schemas: [
        ...m[2]
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "")
          .matchAll(/\bschemas\.(\w+)/g),
      ].map((s) => s[1]),
    });
  }
  return cases;
}

/** `schemas.ts` の `const name = z.object({ kind: z.literal(...) | z.enum([...]) ...` の kind 値。 */
function schemaKinds(schemasSource: string, name: string): string[] | null {
  const start = schemasSource.search(new RegExp(`const\\s+${name}\\s*=`));
  if (start < 0) return null;
  const rest = schemasSource.slice(start + 1);
  const next = rest.search(/\n(?:export\s+)?const\s/);
  const block = next < 0 ? rest : rest.slice(0, next);
  const lit = /\bkind:\s*z\.literal\(\s*"([^"]+)"\s*\)/.exec(block);
  if (lit) return [lit[1]];
  const en = /\bkind:\s*z\.enum\(\s*\[([^\]]*)\]/.exec(block);
  if (en) return [...en[1].matchAll(/"([^"]+)"/g)].map((s) => s[1]);
  return null;
}

/** 1 つの enum について、Rust ↔ switch ↔ スキーマの不一致を文章にして返す (空なら一致)。 */
function diffChannelEnum(
  name: string,
  rustKinds: string[],
  cases: SwitchCase[],
  schemasSource: string,
  emptyKinds: string[] = [],
): string[] {
  const problems: string[] = [];
  const rust = new Set(rustKinds);
  const caseKinds = new Set(cases.map((c) => c.kind));
  for (const k of rust)
    if (!caseKinds.has(k)) problems.push(`${name}: Rust の kind "${k}" に対応する case が switch に無い`);
  for (const k of caseKinds)
    if (!rust.has(k)) problems.push(`${name}: switch の case "${k}" が Rust 側に存在しない`);

  const schemaUnion = new Set<string>();
  for (const c of cases) {
    if (c.schemas.length === 0 && !emptyKinds.includes(c.kind))
      problems.push(`${name}: case "${c.kind}" が Zod スキーマ (schemas.xxx) で検証していない`);
    for (const s of c.schemas) {
      const kinds = schemaKinds(schemasSource, s);
      if (!kinds) {
        problems.push(`${name}: case "${c.kind}" のスキーマ ${s} から kind リテラルを読めない`);
        continue;
      }
      if (!kinds.includes(c.kind))
        problems.push(
          `${name}: case "${c.kind}" のスキーマ ${s} は kind ${JSON.stringify(kinds)} で一致しない`,
        );
      for (const k of kinds) schemaUnion.add(k);
    }
  }
  for (const k of rust)
    if (!schemaUnion.has(k) && !emptyKinds.includes(k))
      problems.push(`${name}: Rust の kind "${k}" を受けるスキーマが無い`);
  for (const k of schemaUnion)
    if (!rust.has(k)) problems.push(`${name}: スキーマの kind "${k}" が Rust 側に存在しない`);
  return problems;
}

// ---------------------------------------------------------------------------

const allRustModules = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const extracted = extractChannelEnums(Object.values(commandModules), Object.values(allRustModules));
const channelEnums = extracted.enums;

describe("Tauri Channel メッセージ enum のバリアント完全性 (Rust enum ⇔ switch ⇔ Zod スキーマ)", () => {
  it("Channel<T> に使われる内部タグ enum を十分な数だけ抽出できている (抽出ロジックの保険)", () => {
    expect(channelEnums.size).toBeGreaterThanOrEqual(7);
    // 代表的な enum と kind 値 (rename_all = camelCase の線形化も確認)。
    expect(channelEnums.get("QueryStreamMessage")?.kinds).toEqual([
      "columns",
      "rows",
      "patch",
      "done",
      "error",
      "cancelled",
    ]);
    expect(channelEnums.get("PreviewStreamMessage")?.kinds).toContain("beforeRows");
    for (const [name, def] of channelEnums) {
      expect(def.kinds.length, `${name} のバリアントを抽出できていない`).toBeGreaterThan(0);
    }
  });

  it("Channel<T> の型がすべて内部タグ enum として解決できている (黙って捨てない)", () => {
    expect(
      extracted.unresolved,
      "解決できない Channel 型があります (パス付き / ジェネリクス / タグ無し enum / 定義なし)。" +
        "kind タグ付きの単純な enum にするか、このテストの抽出を拡張してください",
    ).toEqual([]);
    expect(extracted.duplicates, "同名の enum が複数あり、どれが Channel の型か判別できません").toEqual([]);
  });

  it("すべての Channel enum が `kind` タグで、購読関数 (LISTENERS) に登録されている", () => {
    const tagMismatch = [...channelEnums]
      .filter(([, d]) => d.tag !== "kind")
      .map(([n, d]) => `${n} (tag=${d.tag})`);
    expect(tagMismatch, "tauri.ts の switch (msg.kind) と合わないタグです").toEqual([]);
    const unregistered = [...channelEnums.keys()].filter((n) => !(n in LISTENERS)).sort();
    expect(
      unregistered,
      "LISTENERS に未登録の Channel enum があります。購読関数を作って追記してください",
    ).toEqual([]);
    const stale = Object.keys(LISTENERS).filter((n) => !channelEnums.has(n));
    expect(stale, "Channel の引数に使われなくなった enum が LISTENERS に残っています").toEqual([]);
  });

  for (const [enumName, listener] of Object.entries(LISTENERS)) {
    it(`${enumName} の kind が ${listener} の switch と Zod スキーマに過不足なく対応する`, () => {
      const def = channelEnums.get(enumName);
      expect(def, `${enumName} が Rust から抽出できない`).toBeDefined();
      const cases = extractSwitchCases(apiWrapperSource, listener);
      expect(cases, `${listener} の switch (msg.kind) が見つからない`).not.toBeNull();
      expect(diffChannelEnum(enumName, def?.kinds ?? [], cases ?? [], schemasTs, def?.emptyKinds)).toEqual(
        [],
      );
    });
  }
});

describe("抽出ロジックの自己検証 (合成入力)", () => {
  const rustSrc = `
    #[derive(Serialize)]
    #[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
    pub enum DemoMessage {
        /// doc
        Started { total_rows: u64 },
        BeforeRows { rows: Vec<Vec<u8>> },
        #[serde(rename = "custom-name")]
        Renamed,
        Done {},
    }
    #[derive(Serialize)]
    #[serde(rename_all = "snake_case")]
    pub enum NotTagged { A, B }
    #[tauri::command]
    pub async fn demo(state: State<'_, AppState>, on_event: Channel<DemoMessage>) -> Result<()> { Ok(()) }
  `;

  it("Rust の内部タグ enum を抽出して serde 規則で線形化する", () => {
    const e = extractChannelEnums([rustSrc]).enums;
    expect([...e.keys()]).toEqual(["DemoMessage"]);
    expect(e.get("DemoMessage")?.kinds).toEqual(["started", "beforeRows", "custom-name", "done"]);
    expect(e.get("DemoMessage")?.emptyKinds).toEqual(["custom-name", "done"]);
  });

  it("パス付きの Channel 型は解決し、skip されたバリアントと文字列中の // を扱える", () => {
    const src = `
      #[serde(tag = "kind")]
      enum PathMsg {
          #[serde(rename = "a//b")]
          First,
          #[serde(skip)]
          Hidden,
          Last { url: String },
      }
      #[tauri::command(rename_all = "snake_case")]
      fn f(c: tauri::ipc::Channel<super::x::PathMsg>) {}
    `;
    const r = extractChannelEnums([src]);
    expect(r.unresolved).toEqual([]);
    expect(r.enums.get("PathMsg")?.kinds).toEqual(["a//b", "Last"]);
  });

  it("ジェネリクス / タグ無し enum / 定義なし / ジェネリック enum の Channel 型を未解決として返す", () => {
    const src = `
      #[serde(tag = "kind")]
      enum Tagged<T> { A(T) }
      enum Plain { A, B }
      #[serde(untagged)]
      enum Untagged { A { x: u8 } }
      #[tauri::command]
      fn g(c: Channel<Wrapper<Foo>>) {}
      #[tauri::command]
      fn h(c: Channel<Plain>, d: Channel<Untagged>, e: Channel<Tagged>, f: Channel<Missing>) {}
    `;
    const r = extractChannelEnums([src]);
    expect(r.enums.size).toBe(0);
    expect(r.unresolved).toHaveLength(5);
    expect(r.unresolved[0]).toContain("Wrapper<Foo>");
  });

  it("同名 enum の重複を検出する", () => {
    const src = `
      #[serde(tag = "kind")] enum Dup { A }
      #[serde(tag = "kind")] enum Dup { B }
      #[tauri::command]
      fn g(c: Channel<Dup>) {}
    `;
    expect(extractChannelEnums([src]).duplicates).toEqual(["Dup"]);
  });

  it("バリアント追加 (Rust 側だけ増えた) を switch / スキーマ双方の欠落として検出する", () => {
    const cases: SwitchCase[] = [
      { kind: "started", schemas: ["demoStarted"] },
      { kind: "done", schemas: ["demoDone"] },
    ];
    const schemas = `export const demoStarted = z.object({ kind: z.literal("started") });
export const demoDone = z.object({ kind: z.literal("done") });
`;
    const problems = diffChannelEnum("Demo", ["started", "done", "extra"], cases, schemas);
    expect(problems.some((p) => p.includes('"extra"') && p.includes("switch"))).toBe(true);
    expect(problems.some((p) => p.includes('"extra"') && p.includes("スキーマ"))).toBe(true);
  });

  it("switch の余剰 case とスキーマ kind の食い違いを検出する", () => {
    const cases: SwitchCase[] = [
      { kind: "started", schemas: ["demoStarted"] },
      { kind: "ghost", schemas: ["demoStarted"] },
    ];
    const schemas = `export const demoStarted = z.object({ kind: z.literal("started") });\n`;
    const problems = diffChannelEnum("Demo", ["started"], cases, schemas);
    expect(problems.some((p) => p.includes('case "ghost"') && p.includes("Rust 側に存在しない"))).toBe(true);
    expect(problems.some((p) => p.includes('case "ghost"') && p.includes("一致しない"))).toBe(true);
  });

  it("スキーマを使わない case と z.enum の kind を扱える", () => {
    const schemas = `export const rows = z.object({\n  kind: z.enum(["beforeRows", "afterRows"]),\n});\n`;
    expect(schemaKinds(schemas, "rows")).toEqual(["beforeRows", "afterRows"]);
    const problems = diffChannelEnum("Demo", ["beforeRows"], [{ kind: "beforeRows", schemas: [] }], schemas);
    expect(problems.some((p) => p.includes("検証していない"))).toBe(true);
    // ペイロードの無いバリアントはスキーマ無しの case を許す。
    expect(diffChannelEnum("Demo", ["done"], [{ kind: "done", schemas: [] }], schemas, ["done"])).toEqual([]);
  });

  it("TS の switch から case と schemas.xxx を抽出する", () => {
    const ts = `export async function listenDemo() {
  switch (msg.kind) {
    case "a":
      parse(schemas.demoA, msg);
      break;
    case "b": {
      parse(schemas.demoB, msg);
      break;
    }
    default:
      break;
  }
}
export function other() {}`;
    expect(extractSwitchCases(ts, "listenDemo")).toEqual([
      { kind: "a", schemas: ["demoA"] },
      { kind: "b", schemas: ["demoB"] },
    ]);
    expect(extractSwitchCases(ts, "missing")).toBeNull();
  });
});
