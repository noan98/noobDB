import { describe, expect, it } from "vitest";
import { apiWrapperSource as tauriTs } from "./apiSources";

// 全 Rust ソース (コマンド本体 + serde 型定義 + 型エイリアス)。`import.meta.glob` で
// 機械的に全件取り込む (`ipcArgParity.test.ts` と同じ方式、追記漏れを構造的に無くす)。
const rustModules = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const commandSources = Object.entries(rustModules)
  .filter(([path]) => /\/src-tauri\/src\/commands\/[^/]+\.rs$/.test(path))
  .map(([, src]) => src);
const allRustSources = Object.values(rustModules);

// IPC 引数の「型」ドリフト検出 (#2022)。
//
// `ipcArgParity.test.ts` (#825) は引数**名**の集合しか突き合わせない。Rust 側で
// `u32 → Option<u32>`、`String → bool`、`Vec<T> → T` のように引数の型だけを変えても
// 名前が同じならコンパイルも名前パリティも通り、実行時に serde のデシリアライズ失敗
// (または null の混入) で無音に壊れる。戻り値側は `serdeCoverageParity.test.ts` /
// `schemaParity.test.ts` が型まで固定済みなので、これが入力側の最後の象限。
//
// 粒度は割り切り、「種別 (文字列 / 数値 / 真偽 / 配列 / オブジェクト) + null 許容」で比べる。
//   - Rust: `#[tauri::command]` の引数型。`Option<T>` は null 許容、型エイリアスは展開、
//     名前付き型は struct → オブジェクト / enum → 文字列またはオブジェクト と解決する。
//   - TS: `invoke("cmd", { key: expr })` の値式 + それが参照するラッパー関数のパラメータ型。
//     識別子 / `params.x` / `x ?? null` / リテラルなど静的に分かる式だけを比べ、
//     分からないもの (任意の式・解決できない名前付き型) は「不明」として検査しない。
// 64bit 整数の範囲 (JS の安全整数を超える値) は種別 (number) 粒度では見えないため対象外。
// 「不明」を増やして偽陽性を避ける一方、Rust が確定した種別なのに TS が明確に食い違う
// 場合 (null を渡しうるのに Rust が必須、種別違い) は fail させる。

type Kind = "string" | "number" | "boolean" | "array" | "object";

/** 型の粗い分類。`kinds` が null のときは種別不明 (検査しない)。 */
interface Shape {
  /** 取りうる種別の集合 (null なら不明) */
  kinds: Set<Kind> | null;
  /** null / undefined を受け付ける (Rust: Option、TS: `| null` / `?`) */
  nullable: boolean;
}

const UNKNOWN: Shape = { kinds: null, nullable: false };

/**
 * `angle` が true のとき `<` `>` もネスト深さに数える (型を分割するとき)。TS の値式や
 * invoke の引数では比較演算子 `a > b` が現れるため false にする。
 */
function splitTop(text: string, delimiter: string, trackStrings: boolean, angle: boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      cur += ch;
      if (ch === "\\") {
        i++;
        if (i < text.length) cur += text[i];
      } else if (ch === inStr) inStr = null;
      continue;
    }
    if (trackStrings && (ch === '"' || ch === "'" || ch === "`")) {
      inStr = ch;
      cur += ch;
      continue;
    }
    // `=>` の `>` は閉じ括弧として数えない。
    if (ch === ">" && text[i - 1] === "=") {
      cur += ch;
      continue;
    }
    if ("([{".includes(ch) || (angle && ch === "<")) depth++;
    else if (")]}".includes(ch) || (angle && ch === ">")) depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function matchClose(text: string, openIdx: number, trackStrings: boolean): number {
  const open = text[openIdx];
  const close = open === "(" ? ")" : open === "[" ? "]" : open === "{" ? "}" : ">";
  let depth = 0;
  let inStr: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (trackStrings && (ch === '"' || ch === "'" || ch === "`")) {
      inStr = ch;
      continue;
    }
    if (open === "<" && ch === ">" && text[i - 1] === "=") continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? line.replace(/./g, " ") : line))
    .join("\n");
}

// ---------------------------------------------------------------- Rust 側

const NUMBER_TYPES = new Set([
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "f32",
  "f64",
]);
const STRING_TYPES = new Set(["String", "str", "PathBuf", "Path", "char"]);
const ARRAY_TYPES = new Set(["Vec", "VecDeque", "HashSet", "BTreeSet"]);
const OBJECT_TYPES = new Set(["HashMap", "BTreeMap"]);

interface RustTypeDefs {
  aliases: Map<string, string>;
  structs: Map<string, Shape>;
  enums: Set<string>;
}

/** 全 Rust ソースから型エイリアス / struct / enum の定義を集める。 */
function collectRustTypeDefs(sources: string[]): RustTypeDefs {
  const aliases = new Map<string, string>();
  const structs = new Map<string, Shape>();
  const enums = new Set<string>();
  for (const raw of sources) {
    const src = stripLineComments(raw);
    for (const m of src.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)\s*=\s*([^;]+);/gm)) {
      aliases.set(m[1], m[2].trim());
    }
    for (const m of src.matchAll(
      /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?(struct|enum)\s+(\w+)\s*(<[^>{(;]*>)?\s*([{(;])?/g,
    )) {
      const attrs = m[1];
      const name = m[3];
      if (m[2] === "enum") {
        // `#[serde(untagged)]` は任意の形になりうるので、名前付き型の解決対象から外す (不明扱い)。
        if (!/untagged/.test(attrs)) enums.add(name);
        continue;
      }
      // `#[serde(transparent)]` / タプル構造体 (newtype) / ユニット構造体は中身次第なので不明扱い。
      if (/transparent/.test(attrs) || m[5] !== "{") {
        structs.set(name, UNKNOWN);
        continue;
      }
      structs.set(name, { kinds: new Set<Kind>(["object"]), nullable: false });
    }
  }
  return { aliases, structs, enums };
}

/** Rust の型文字列を {@link Shape} に分類する。 */
function classifyRustType(rawType: string, defs: RustTypeDefs, depth = 0): Shape {
  if (depth > 8) return UNKNOWN;
  let t = rawType.trim().replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, "");
  t = t.replace(/^impl\s+.*/, "impl");
  if (t.startsWith("(")) return { kinds: new Set<Kind>(["array"]), nullable: false }; // タプルは JSON 配列
  if (t.startsWith("[")) return { kinds: new Set<Kind>(["array"]), nullable: false };
  const lt = t.indexOf("<");
  const head = (lt === -1 ? t : t.slice(0, lt)).trim().split("::").pop() ?? "";
  const inner = lt === -1 ? "" : t.slice(lt + 1, t.lastIndexOf(">"));
  if (head === "Option") {
    const s = classifyRustType(inner, defs, depth + 1);
    return { kinds: s.kinds, nullable: true };
  }
  if (head === "Box" || head === "Arc" || head === "Cow") return classifyRustType(inner, defs, depth + 1);
  if (head === "bool") return { kinds: new Set<Kind>(["boolean"]), nullable: false };
  if (NUMBER_TYPES.has(head)) return { kinds: new Set<Kind>(["number"]), nullable: false };
  if (STRING_TYPES.has(head)) return { kinds: new Set<Kind>(["string"]), nullable: false };
  if (ARRAY_TYPES.has(head)) return { kinds: new Set<Kind>(["array"]), nullable: false };
  if (OBJECT_TYPES.has(head)) return { kinds: new Set<Kind>(["object"]), nullable: false };
  // `serde_json::Value` は null も含め何でも受ける。
  if (head === "Value") return { kinds: null, nullable: true };
  const alias = defs.aliases.get(head);
  if (alias !== undefined) return classifyRustType(alias, defs, depth + 1);
  const st = defs.structs.get(head);
  if (st) return st;
  // enum は単純列挙なら文字列、データ付きならオブジェクトになるため両方許す。
  if (defs.enums.has(head)) return { kinds: new Set<Kind>(["string", "object"]), nullable: false };
  return UNKNOWN;
}

function isInjectedArgType(rustType: string): boolean {
  const head = rustType.trim().split(/[<\s]/)[0];
  return ["State", "AppHandle", "Window", "WebviewWindow", "tauri::ipc::Request", "Request"].includes(head);
}

/** `コマンド名 → [{引数名(camelCase), Rust 型文字列}]` を抽出する (注入型は除外)。 */
function extractRustCommandParamTypes(source: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  const scan = stripLineComments(source);
  const attrRe = /#\[tauri::command\]/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(scan)) !== null) {
    const braceIdx = source.indexOf("{", am.index);
    if (braceIdx === -1) continue;
    const chunk = source.slice(am.index, braceIdx);
    const fm = /\bfn\s+([a-zA-Z_]\w*)\s*(?:<[^(]*>)?\s*\(/.exec(chunk);
    if (!fm) throw new Error(`#[tauri::command] の直後に fn が見つからない: ${chunk.slice(0, 80)}`);
    const openParen = fm.index + fm[0].length - 1;
    const closeParen = matchClose(chunk, openParen, false);
    if (closeParen === -1) throw new Error(`${fm[1]} の引数リストが閉じていない`);
    const params = chunk.slice(openParen + 1, closeParen).replace(/\/\/[^\n]*/g, "");
    const map = new Map<string, string>();
    for (const raw of splitTop(params, ",", false, true)
      .map((p) => p.trim())
      .filter((p) => p !== "")) {
      const cleaned = raw.replace(/^mut\s+/, "");
      const colon = cleaned.indexOf(":");
      if (colon === -1) continue;
      const type = cleaned.slice(colon + 1).trim();
      if (isInjectedArgType(type)) continue;
      map.set(snakeToCamel(cleaned.slice(0, colon).trim()), type);
    }
    result.set(fm[1], map);
  }
  return result;
}

// ---------------------------------------------------------------- TS 側

/** TS のローカルな型エイリアス (`type X = ...;`)。ラッパー層から参照されるもののうち解決できるもの。 */
function collectTsAliases(source: string, extraSources: string[] = []): Map<string, string> {
  const aliases = new Map<string, string>();
  // `interface X { ... }` は本体を `{ ... }` のオブジェクト型として登録する (extends は無視)。
  for (const src of [source, ...extraSources]) {
    for (const m of src.matchAll(
      /^(?:export\s+)?interface\s+(\w+)(?:<[^>{]*>)?(?:\s+extends\s+[^{]+)?\s*\{/gm,
    )) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(src, open, true);
      if (close !== -1 && !aliases.has(m[1])) aliases.set(m[1], src.slice(open, close + 1));
    }
    for (const m of src.matchAll(/^(?:export\s+)?type\s+(\w+)\s*=\s*(\{)/gm)) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(src, open, true);
      if (close !== -1 && !aliases.has(m[1])) aliases.set(m[1], src.slice(open, close + 1));
    }
  }
  for (const m of source.matchAll(/^(?:export\s+)?type\s+(\w+)\s*=\s*([^;]+);/gm)) {
    if (!aliases.has(m[1])) aliases.set(m[1], m[2].trim());
  }
  return aliases;
}

function classifyTsType(rawType: string, aliases: Map<string, string>, depth = 0): Shape {
  if (depth > 8) return UNKNOWN;
  const t = rawType.trim().replace(/^\|\s*/, "");
  if (t === "") return UNKNOWN;
  const members = splitTop(t, "|", true, true).map((s) => s.trim());
  if (members.length > 1) {
    let nullable = false;
    const kinds = new Set<Kind>();
    let known = true;
    for (const mem of members) {
      const s = classifyTsType(mem, aliases, depth + 1);
      nullable ||= s.nullable;
      if (s.kinds === null) {
        if (!s.nullable) known = false;
      } else for (const k of s.kinds) kinds.add(k);
    }
    return { kinds: known ? kinds : null, nullable };
  }
  if (t === "null" || t === "undefined" || t === "void") return { kinds: new Set(), nullable: true };
  if (t.endsWith("[]") || /^(?:Readonly)?Array<.*>$/s.test(t) || t.startsWith("["))
    return { kinds: new Set<Kind>(["array"]), nullable: false };
  if (t === "string" || /^(["'`]).*\1$/s.test(t) || t === "Date")
    return { kinds: new Set<Kind>(["string"]), nullable: false };
  if (t === "number" || t === "bigint" || /^-?\d+(\.\d+)?$/.test(t))
    return { kinds: new Set<Kind>(["number"]), nullable: false };
  if (t === "boolean" || t === "true" || t === "false")
    return { kinds: new Set<Kind>(["boolean"]), nullable: false };
  if (t.startsWith("{") || /^(?:Record|Partial|Pick|Omit)</.test(t))
    return { kinds: new Set<Kind>(["object"]), nullable: false };
  if (t.startsWith("(")) return UNKNOWN;
  if (/^\w+$/.test(t)) {
    const a = aliases.get(t);
    if (a !== undefined) return classifyTsType(a, aliases, depth + 1);
  }
  // `unknown` / `any` / 解決できない名前付き型 (interface など) は不明。
  return UNKNOWN;
}

interface WrapperParam {
  /** `名前?: 型` の型文字列 (無ければ空)。 */
  type: string;
  optional: boolean;
  hasDefault: boolean;
}

/** `invoke` 呼び出し位置 `at` を含むラッパー関数のパラメータ表を返す (分からなければ空)。 */
function findEnclosingWrapperParams(source: string, at: number): Map<string, WrapperParam> {
  const head = source.slice(0, at);
  // 直前にある `名前: (` / `名前: async (` / `function 名前(` / `const 名前 = (` の最後のもの。
  const re =
    /(?:^|\n)[ \t]*(?:export\s+)?(?:(?:async\s+)?function\s+\w+\s*(?:<[^(]*>)?\s*\(|(?:const\s+)?\w+\s*[:=]\s*(?:async\s+)?(?:<[^(]*>)?\s*\()/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) !== null) last = m;
  const result = new Map<string, WrapperParam>();
  if (!last) return result;
  const openIdx = last.index + last[0].length - 1;
  const closeIdx = matchClose(source, openIdx, true);
  if (closeIdx === -1 || closeIdx > at) return result;
  for (const p of splitTop(source.slice(openIdx + 1, closeIdx), ",", true, true)
    .map((s) => s.trim())
    .filter((s) => s !== "")) {
    const pm = /^(\w+)(\?)?\s*(?::\s*([\s\S]*?))?(?:\s=\s([\s\S]*))?$/.exec(p);
    if (!pm) continue;
    let type = pm[3] ?? "";
    // 型注釈が無く既定値だけある引数は、既定値のリテラルから種別を推論する。
    if (type === "" && pm[4] !== undefined) {
      const lit = pm[4].trim();
      if (lit === "true" || lit === "false") type = "boolean";
      else if (/^-?\d+(\.\d+)?$/.test(lit)) type = "number";
      else if (/^(["'`]).*\1$/s.test(lit)) type = "string";
      else if (lit.startsWith("[")) type = "unknown[]";
    }
    result.set(pm[1], { type, optional: pm[2] === "?", hasDefault: pm[4] !== undefined });
  }
  return result;
}

/** オブジェクト型リテラル `{ a: string; b?: number }` から各メンバーの型を取り出す。 */
function parseObjectTypeMembers(typeText: string): Map<string, WrapperParam> {
  const members = new Map<string, WrapperParam>();
  const t = typeText.trim();
  if (!t.startsWith("{")) return members;
  const close = matchClose(t, 0, true);
  if (close === -1) return members;
  const body = t
    .slice(1, close)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const part of splitTop(body.replace(/;/g, ","), ",", true, true)
    .map((s) => s.trim())
    .filter((s) => s !== "")) {
    const pm = /^(\w+)(\?)?\s*:\s*([\s\S]+)$/.exec(part);
    if (pm) members.set(pm[1], { type: pm[3].trim(), optional: pm[2] === "?", hasDefault: false });
  }
  return members;
}

/** invoke のキー値式を {@link Shape} に分類する。 */
function classifyTsValue(
  expr: string,
  params: Map<string, WrapperParam>,
  aliases: Map<string, string>,
): Shape {
  const e = expr.trim();
  // `x ?? null` — null を渡しうる。`x ?? 既定値` — null は渡らない。
  const nn = /^([\s\S]+?)\s*\?\?\s*([\s\S]+)$/.exec(e);
  if (nn && !/[?:]\s/.test(nn[1]) && !/^[({[]/.test(nn[1])) {
    const left = classifyTsValue(nn[1], params, aliases);
    const right = nn[2].trim();
    if (right === "null" || right === "undefined") return { kinds: left.kinds, nullable: true };
    const r = classifyTsValue(right, params, aliases);
    return { kinds: left.kinds ?? r.kinds, nullable: false };
  }
  if (/^(["'`]).*\1$/s.test(e)) return { kinds: new Set<Kind>(["string"]), nullable: false };
  if (/^-?\d+(\.\d+)?$/.test(e)) return { kinds: new Set<Kind>(["number"]), nullable: false };
  if (e === "true" || e === "false") return { kinds: new Set<Kind>(["boolean"]), nullable: false };
  if (e === "null") return { kinds: new Set(), nullable: true };
  if (e.startsWith("[") && e.endsWith("]")) return { kinds: new Set<Kind>(["array"]), nullable: false };
  if (e.startsWith("{") && e.endsWith("}") && matchClose(e, 0, true) === e.length - 1)
    return { kinds: new Set<Kind>(["object"]), nullable: false };
  if (/\.(?:map|filter)\([\s\S]*\)$/.test(e)) return { kinds: new Set<Kind>(["array"]), nullable: false };
  if (/^JSON\.stringify\(/.test(e)) return { kinds: new Set<Kind>(["string"]), nullable: false };
  let p: WrapperParam | undefined;
  let member: string | undefined;
  const ident = /^(\w+)$/.exec(e);
  const dotted = /^(\w+)\.(\w+)$/.exec(e);
  if (ident) p = params.get(ident[1]);
  else if (dotted) {
    const base = params.get(dotted[1]);
    if (base) {
      const baseType = /^\w+$/.test(base.type.trim())
        ? (aliases.get(base.type.trim()) ?? base.type)
        : base.type;
      p = parseObjectTypeMembers(baseType).get(dotted[2]);
      member = dotted[2];
    }
  }
  if (!p || (dotted && member === undefined)) return UNKNOWN;
  if (p.type === "") return UNKNOWN;
  const s = classifyTsType(p.type, aliases);
  return { kinds: s.kinds, nullable: s.nullable || p.optional };
}

interface InvokeArg {
  shape: Shape;
  expr: string;
}

/** `コマンド名 → {キー → 引数の型分類}`。 */
function extractInvokeArgTypes(
  source: string,
  aliases: Map<string, string>,
): Map<string, Map<string, InvokeArg>> {
  const out = new Map<string, Map<string, InvokeArg>>();
  const re = /\binvoke\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length;
    while (/\s/.test(source[i] ?? "")) i++;
    if (source[i] === "<") {
      const c = matchClose(source, i, false);
      if (c === -1) continue;
      i = c + 1;
      while (/\s/.test(source[i] ?? "")) i++;
    }
    if (source[i] !== "(") continue;
    const close = matchClose(source, i, true);
    if (close === -1) continue;
    const rawArgs = splitTop(source.slice(i + 1, close), ",", true, false)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const cmd = /^"([a-z_][a-z0-9_]*)"$/.exec(rawArgs[0] ?? "");
    if (!cmd) continue;
    const args = new Map<string, InvokeArg>();
    out.set(cmd[1], args);
    const obj = rawArgs[1];
    if (!obj || !obj.startsWith("{") || !obj.endsWith("}")) continue;
    const params = findEnclosingWrapperParams(source, m.index);
    for (const prop of splitTop(obj.slice(1, -1), ",", true, false)
      .map((s) => s.trim())
      .filter((s) => s !== "")) {
      const colon = firstTopColon(prop);
      const key = (colon === -1 ? prop : prop.slice(0, colon)).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
      const expr = colon === -1 ? key : prop.slice(colon + 1).trim();
      args.set(key, { shape: classifyTsValue(expr, params, aliases), expr });
    }
  }
  return out;
}

function firstTopColon(text: string): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inStr = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ":" && depth === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- 突き合わせ

/**
 * 意図的に食い違う引数の許可リスト (`"command.argKey": 理由`)。足すときは必ず理由を書く。
 * 現時点で正当な差分は無い。
 */
const KNOWN_TYPE_DIFFERENCES: Record<string, string> = {};

/** Rust 型 (rust) と TS の値 (ts) が食い違う理由を返す。問題なければ null、検査不能なら "skip"。 */
function compareShapes(rust: Shape, ts: Shape): string | null | "skip" {
  const problems: string[] = [];
  if (ts.nullable && !rust.nullable)
    problems.push("TS は null/undefined を渡しうるが Rust は必須 (Option ではない)");
  if (rust.kinds !== null && ts.kinds !== null && ts.kinds.size > 0) {
    const bad = [...ts.kinds].filter((k) => !rust.kinds?.has(k));
    if (bad.length > 0)
      problems.push(`種別が違う: Rust=[${[...rust.kinds].join("|")}] TS=[${[...ts.kinds].join("|")}]`);
  }
  if (problems.length > 0) return problems.join(" / ");
  if (rust.kinds === null || ts.kinds === null) return ts.nullable ? null : "skip";
  return null;
}

const defs = collectRustTypeDefs(allRustSources);
const tsTypeSources = Object.entries(
  import.meta.glob("../**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" }) as Record<
    string,
    string
  >,
)
  .filter(([path]) => !path.includes("/__tests__/"))
  .map(([, src]) => src);
const tsAliases = collectTsAliases(tauriTs, tsTypeSources);

const backendTypes = new Map<string, Map<string, string>>();
for (const src of commandSources) {
  for (const [name, params] of extractRustCommandParamTypes(src)) backendTypes.set(name, params);
}
const frontendTypes = extractInvokeArgTypes(tauriTs, tsAliases);

/** 種別照合できた件数と、TS 側が不明で検査できなかった件数。 */
function countCoverage(
  backend: Map<string, Map<string, string>>,
  frontend: Map<string, Map<string, InvokeArg>>,
  rustDefs: RustTypeDefs,
): { compared: number; tsUnknown: number } {
  let compared = 0;
  let tsUnknown = 0;
  for (const [cmd, rustParams] of backend) {
    for (const [key, rustType] of rustParams) {
      const arg = frontend.get(cmd)?.get(key);
      if (!arg) continue;
      if (arg.shape.kinds === null) tsUnknown++;
      else if (classifyRustType(rustType, rustDefs).kinds !== null) compared++;
    }
  }
  return { compared, tsUnknown };
}

function findMismatches(
  backend: Map<string, Map<string, string>>,
  frontend: Map<string, Map<string, InvokeArg>>,
  rustDefs: RustTypeDefs,
): { mismatches: string[]; compared: number } {
  const mismatches: string[] = [];
  let compared = 0;
  for (const [cmd, rustParams] of backend) {
    const tsArgs = frontend.get(cmd);
    if (!tsArgs) continue;
    for (const [key, rustType] of rustParams) {
      const arg = tsArgs.get(key);
      if (!arg) continue;
      const verdict = compareShapes(classifyRustType(rustType, rustDefs), arg.shape);
      if (verdict === "skip") continue;
      compared++;
      if (verdict !== null && !(`${cmd}.${key}` in KNOWN_TYPE_DIFFERENCES)) {
        mismatches.push(`${cmd}.${key}: ${verdict} (Rust: ${rustType} / TS: ${arg.expr})`);
      }
    }
  }
  return { mismatches: mismatches.sort(), compared };
}

describe("IPC 引数型パリティ (Rust コマンドの引数型 ↔ tauri.ts ラッパーの引数型、#2022)", () => {
  it("抽出ロジックの保険: 十分な数の引数が両側から型付きで取れている", () => {
    expect(backendTypes.size).toBeGreaterThanOrEqual(200);
    expect(frontendTypes.size).toBeGreaterThanOrEqual(200);
    expect(findMismatches(backendTypes, frontendTypes, defs).compared).toBeGreaterThanOrEqual(500);
  });

  it("Rust にある引数キーが TS 側の抽出から落ちていない (抽出失敗の検知)", () => {
    const missing: string[] = [];
    for (const [cmd, rustParams] of backendTypes) {
      const tsArgs = frontendTypes.get(cmd);
      if (!tsArgs) continue; // 名前レベルの欠落は ipcCommandParity / ipcArgParity の担当
      for (const key of rustParams.keys()) if (!tsArgs.has(key)) missing.push(`${cmd}.${key}`);
    }
    expect(missing.sort(), `TS 側で抽出できていない引数: ${missing.join(", ")}`).toEqual([]);
  });

  it("Rust 型の分類 (Option / エイリアス / struct / enum / ジェネリクス)", () => {
    const d = collectRustTypeDefs([
      "type Ids = Vec<String>;\n#[derive(Deserialize)]\npub struct Req { pub a: u32 }\n#[derive(Deserialize)]\npub enum Fmt { A, B }\n#[serde(transparent)]\npub struct Newtype(String);",
    ]);
    const k = (t: string) => {
      const s = classifyRustType(t, d);
      return `${s.kinds ? [...s.kinds].sort().join("|") : "?"}${s.nullable ? "?" : ""}`;
    };
    expect(k("String")).toBe("string");
    expect(k("&str")).toBe("string");
    expect(k("Option<u64>")).toBe("number?");
    expect(k("Option<Vec<String>>")).toBe("array?");
    expect(k("&[String]")).toBe("array");
    expect(k("Ids")).toBe("array");
    expect(k("Req")).toBe("object");
    expect(k("Fmt")).toBe("object|string");
    expect(k("Newtype")).toBe("?");
    expect(k("Option<serde_json::Value>")).toBe("??");
    expect(k("HashMap<String, u32>")).toBe("object");
  });

  it("TS 値の分類 (識別子 / params.x / ?? null / リテラル)", () => {
    const params = new Map<string, WrapperParam>([
      ["sessionId", { type: "string", optional: false, hasDefault: false }],
      ["limit", { type: "number", optional: true, hasDefault: false }],
      ["opts", { type: "{ a: boolean; b?: string[] }", optional: false, hasDefault: false }],
      ["mode", { type: '"a" | "b" | null', optional: false, hasDefault: false }],
    ]);
    const k = (e: string) => {
      const s = classifyTsValue(e, params, new Map());
      return `${s.kinds ? [...s.kinds].sort().join("|") : "?"}${s.nullable ? "?" : ""}`;
    };
    expect(k("sessionId")).toBe("string");
    expect(k("limit")).toBe("number?");
    expect(k("limit ?? null")).toBe("number?");
    expect(k("limit ?? 10")).toBe("number");
    expect(k("opts.a")).toBe("boolean");
    expect(k("opts.b")).toBe("array?");
    expect(k("mode")).toBe("string?");
    expect(k("unknownVar")).toBe("?");
  });

  it("引数に比較演算子 (>) を含む invoke も分割されずキーが取れる", () => {
    const ts = `
export const x = {
  a: (ids: string[], n: number) =>
    invoke<void>("cmd_a", { ids: ids.length > 0 ? ids : null, n }),
};`;
    const frontend = extractInvokeArgTypes(ts, new Map());
    expect([...(frontend.get("cmd_a")?.keys() ?? [])]).toEqual(["ids", "n"]);
    const run = (rust: string) =>
      findMismatches(
        extractRustCommandParamTypes(`#[tauri::command]\n${rust} {`),
        frontend,
        collectRustTypeDefs([]),
      ).mismatches;
    expect(run("pub async fn cmd_a(ids: Option<Vec<String>>, n: u32) -> Result<()>")).toEqual([]);
    expect(run("pub async fn cmd_a(ids: Option<Vec<String>>, n: String) -> Result<()>")).toHaveLength(1);
  });

  it("interface / 既定値からの推論 / オブジェクト・map 式", () => {
    const aliases = collectTsAliases("", ["export interface P { a: string; b?: number[] }"]);
    const ts = `
export const x = {
  a: (p: P, flag = false, limit = 10) =>
    invoke<void>("cmd_a", { a: p.a, b: p.b, flag, limit, o: { z: 1 }, m: ids.map((i) => i) }),
};`;
    const args = extractInvokeArgTypes(ts, aliases).get("cmd_a");
    const k = (key: string) => {
      const sh = args?.get(key)?.shape;
      return `${sh?.kinds ? [...sh.kinds].join("|") : "?"}${sh?.nullable ? "?" : ""}`;
    };
    expect([k("a"), k("b"), k("flag"), k("limit"), k("o"), k("m")]).toEqual([
      "string",
      "array?",
      "boolean",
      "number",
      "object",
      "array",
    ]);
  });

  it("意図的に型をずらした差分を検出できる (ミューテーション確認)", () => {
    const ts = `
export const x = {
  a: (sessionId: string, limit?: number | null, flag?: boolean) =>
    invoke<void>("cmd_a", { sessionId, limit: limit ?? null, flag }),
};`;
    const frontend = extractInvokeArgTypes(ts, new Map());
    const run = (rust: string) =>
      findMismatches(
        extractRustCommandParamTypes(`#[tauri::command]\n${rust} {`),
        frontend,
        collectRustTypeDefs([]),
      ).mismatches;

    // 正: TS が string / number|null / boolean|undefined、Rust が String / Option<u32> / Option<bool>。
    expect(
      run("pub async fn cmd_a(session_id: String, limit: Option<u32>, flag: Option<bool>) -> Result<()>"),
    ).toEqual([]);
    // Option<u32> → u32 (null を渡しうるのに必須)。
    expect(
      run("pub async fn cmd_a(session_id: String, limit: u32, flag: Option<bool>) -> Result<()>"),
    ).toHaveLength(1);
    // String → bool (種別違い)。
    expect(
      run("pub async fn cmd_a(session_id: bool, limit: Option<u32>, flag: Option<bool>) -> Result<()>"),
    ).toHaveLength(1);
    // Option<u32> → Option<String>。
    expect(
      run("pub async fn cmd_a(session_id: String, limit: Option<String>, flag: Option<bool>) -> Result<()>"),
    ).toHaveLength(1);
    // Option<bool> → Vec<bool>。
    expect(
      run("pub async fn cmd_a(session_id: String, limit: Option<u32>, flag: Vec<bool>) -> Result<()>").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("両側に存在する引数の型分類が食い違わない", () => {
    const { mismatches } = findMismatches(backendTypes, frontendTypes, defs);
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("KNOWN_TYPE_DIFFERENCES に不要なエントリが残っていない", () => {
    const stale = Object.keys(KNOWN_TYPE_DIFFERENCES).filter((id) => {
      const [cmd, key] = id.split(".");
      return !backendTypes.get(cmd)?.has(key) || !frontendTypes.get(cmd)?.has(key);
    });
    expect(stale, `存在しない引数の許可エントリ: ${stale.join(", ")}`).toEqual([]);
  });
});
