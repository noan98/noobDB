/**
 * テーブル定義 (列メタデータ) から TypeScript / Go / Rust / Python の型定義を生成する純ロジック (#2411)。
 *
 * 副作用なし。IPC もここでは呼ばず、呼び出し側 (`TypeDefModal`) が `describeDatabase` /
 * `valuePicker.ts` で集めた列情報 ({@link TypeDefTable}) を渡す。対応表は `typeDefGen.test.ts` で固定する。
 *
 * ## 型の対応方針
 * - **64bit 整数 → TS では `string`**: JS の安全整数を超えるとバックエンド (`Value::from_*_lossless`) が
 *   文字列で返すため。ただし SQLite の `INTEGER` は rowid 主キーなど 64bit の宣言が既定で
 *   使い物にならなくなるので `number` にする。
 * - **DECIMAL → TS は `string`** (精度を落とさない)。日時・UUID・BLOB(16 進) も TS では `string`
 *   (JSON 越しに届く表現に合わせる)。
 * - **ENUM → TS / Python は union (Literal)、Go / Rust は `string` + コメント**。値が取れなければ `string`。
 * - **PostgreSQL の配列**: `integer[]` / `_int4` は要素型まで辿る。`information_schema` が返す `ARRAY`
 *   (要素型の情報なし) は要素を不明 (`unknown[]` / `[]any` / `Vec<serde_json::Value>` / `list[Any]`) とする。
 * - **識別子**: 空白・記号・先頭数字・予約語は言語ごとに安全な名前へ変換し、元の列名は Go の `db` タグ /
 *   Rust の `#[sqlx(rename)]` / Pydantic の `alias` / TS・Python のコメントに残す。
 */

import { baseTypeName } from "./cellTypeMeta";
import { quoteString } from "./cellEdit";
import { allowedValuesFromType } from "./valuePicker";

export const TYPE_DEF_LANGS = [
  "typescript",
  "typescriptZod",
  "go",
  "rust",
  "python",
  "pythonPydantic",
] as const;
export type TypeDefLang = (typeof TYPE_DEF_LANGS)[number];

export const TYPE_DEF_NAMINGS = ["snake", "camel"] as const;
export type TypeDefNaming = (typeof TYPE_DEF_NAMINGS)[number];

/** 命名規則 (camel / snake) を選べる言語。Go (PascalCase 固定) と Rust (snake_case 固定) は言語の慣習に従う。 */
export function namingApplies(lang: TypeDefLang): boolean {
  return lang !== "go" && lang !== "rust";
}

export interface TypeDefColumn {
  name: string;
  /** DB カタログの型名 (`varchar(255)` / `character varying(50)` / `enum('a','b')` など)。 */
  data_type: string;
  nullable: boolean;
  comment?: string | null;
  /** ENUM の許可値。未指定なら MySQL の `enum(...)` 型名から取り出す。 */
  enumValues?: string[] | null;
}

export interface TypeDefTable {
  name: string;
  comment?: string | null;
  columns: TypeDefColumn[];
}

export interface TypeDefOptions {
  driver: string;
  lang: TypeDefLang;
  naming: TypeDefNaming;
}

/**
 * PostgreSQL の列ごとの正確な型名 (`integer[]` など) を引く読み取りクエリ。行 = `[列名, 型名]`。
 * `information_schema` は配列列を `ARRAY` としか返さないので、要素型を知るために使う。
 */
export function buildPgColumnTypesQuery(schema: string, table: string): string {
  const lit = (s: string) => quoteString("postgres", s);
  return (
    "SELECT a.attname, pg_catalog.format_type(a.atttypid, NULL) FROM pg_catalog.pg_attribute a" +
    " JOIN pg_catalog.pg_class c ON c.oid = a.attrelid" +
    " JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace" +
    ` WHERE n.nspname = ${lit(schema)} AND c.relname = ${lit(table)}` +
    " AND a.attnum > 0 AND NOT a.attisdropped"
  );
}

// ---------------------------------------------------------------------------
// 1. 型の分類 (言語に依らない中間表現)
// ---------------------------------------------------------------------------

export type TypeIR =
  | { k: "int"; bits: 8 | 16 | 32 | 64; unsigned: boolean; jsSafe: boolean }
  | { k: "float"; bits: 32 | 64 }
  | { k: "decimal" }
  | { k: "bool" }
  | { k: "string" }
  | { k: "uuid" }
  | { k: "date" }
  | { k: "time" }
  | { k: "datetime"; tz: boolean }
  | { k: "json" }
  | { k: "binary" }
  | { k: "enum"; values: string[] }
  | { k: "array"; of: TypeIR | null };

const INT = (bits: 8 | 16 | 32 | 64, unsigned: boolean, jsSafe = false): TypeIR => ({
  k: "int",
  bits,
  unsigned,
  jsSafe,
});

const STRING_TYPES = new Set([
  "char",
  "varchar",
  "character",
  "character varying",
  "bpchar",
  "text",
  "tinytext",
  "mediumtext",
  "longtext",
  "citext",
  "name",
  "nchar",
  "nvarchar",
  "national char",
  "national varchar",
  "clob",
  "string",
  '"char"',
]);
const BINARY_TYPES = new Set(["blob", "tinyblob", "mediumblob", "longblob", "binary", "varbinary", "bytea"]);
const DECIMAL_TYPES = new Set(["numeric", "decimal", "dec", "fixed", "money", "smallmoney"]);

/**
 * DB カタログの型名を中間表現へ分類する。未知の型 (interval / inet / geometry など) は `string`。
 * `enumValues` が渡されたときだけ ENUM (PostgreSQL の `USER-DEFINED` を含む) を union として扱う。
 */
export function classifyColumnType(driver: string, dataType: string, enumValues?: string[] | null): TypeIR {
  const lower = dataType.trim().toLowerCase();
  if (lower === "array") return { k: "array", of: null };
  // `integer[]` / `text[][]` (多次元も 1 次元のリストとして扱う)。
  if (/\[\d*\]$/.test(lower)) {
    return { k: "array", of: classifyColumnType(driver, lower.replace(/(\[\d*\])+$/, ""), null) };
  }
  // pg_type の配列型名 (`_int4`)。
  if (driver === "postgres" && /^_[a-z]/.test(lower)) {
    return { k: "array", of: classifyColumnType(driver, lower.slice(1), null) };
  }

  const unsigned = /\bunsigned\b/.test(lower);
  const width = /\((\d+)\)/.exec(lower)?.[1];
  const base = baseTypeName(lower)
    .replace(/\b(unsigned|signed|zerofill)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (base === "enum" || base === "user-defined") {
    return enumValues && enumValues.length > 0 ? { k: "enum", values: enumValues } : { k: "string" };
  }
  if (STRING_TYPES.has(base) || base === "set") return { k: "string" };
  if (BINARY_TYPES.has(base)) return { k: "binary" };
  if (DECIMAL_TYPES.has(base)) return { k: "decimal" };

  switch (base) {
    case "tinyint":
      // MySQL の慣習: `tinyint(1)` は真偽値 (sqlx も bool としてデコードする)。
      if (driver === "mysql" && width === "1" && !unsigned) return { k: "bool" };
      return INT(8, unsigned);
    case "smallint":
    case "int2":
    case "smallserial":
      return INT(16, unsigned);
    case "year":
      return INT(16, true);
    case "mediumint":
      return INT(32, unsigned);
    case "int":
    case "integer":
      // SQLite の INTEGER は 64bit だが、rowid 主キーなどを一律 string にすると使い物にならない。
      if (driver === "sqlite") return INT(64, false, true);
      return INT(32, unsigned);
    case "int4":
    case "serial":
      return INT(32, unsigned);
    case "bigint":
    case "int8":
    case "bigserial":
    case "serial8":
      return INT(64, unsigned);
    case "float":
      // SQLite の REAL / FLOAT は 8 バイト浮動小数。
      return { k: "float", bits: driver === "sqlite" ? 64 : 32 };
    case "real":
    case "float4":
      return { k: "float", bits: driver === "sqlite" ? 64 : 32 };
    case "double":
    case "double precision":
    case "float8":
      return { k: "float", bits: 64 };
    case "bool":
    case "boolean":
      return { k: "bool" };
    case "uuid":
      return { k: "uuid" };
    case "date":
      return { k: "date" };
    case "time":
    case "time without time zone":
    case "time with time zone":
    case "timetz":
      return { k: "time" };
    case "datetime":
    case "timestamp without time zone":
      return { k: "datetime", tz: false };
    case "timestamp":
      // MySQL の TIMESTAMP は UTC 保存 (sqlx は DateTime<Utc>)。PostgreSQL の裸の timestamp は時刻帯なし。
      return { k: "datetime", tz: driver === "mysql" };
    case "timestamp with time zone":
    case "timestamptz":
      return { k: "datetime", tz: true };
    case "json":
    case "jsonb":
      return { k: "json" };
    case "bit":
      return driver === "mysql" ? { k: "binary" } : { k: "string" };
    default:
      return { k: "string" };
  }
}

function columnIR(driver: string, col: TypeDefColumn): TypeIR {
  const values =
    col.enumValues ??
    (() => {
      const a = allowedValuesFromType(driver, col.data_type);
      return a?.kind === "enum" ? a.values : null;
    })();
  return classifyColumnType(driver, col.data_type, values);
}

// ---------------------------------------------------------------------------
// 2. 識別子の変換
// ---------------------------------------------------------------------------

/** 単語へ分割する (記号・空白・camelCase の境界・数字の塊)。 */
export function splitWords(name: string): string[] {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

export function toSnakeCase(name: string): string {
  return splitWords(name)
    .map((w) => w.toLowerCase())
    .join("_");
}

export function toCamelCase(name: string): string {
  const words = splitWords(name);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w))).join("");
}

export function toPascalCase(name: string): string {
  return splitWords(name).map(cap).join("");
}

/** Go の命名慣習 (lint の initialism)。PascalCase 化した単語がこれに一致したら大文字にする。 */
const GO_INITIALISMS = new Set([
  "id",
  "url",
  "uuid",
  "ip",
  "api",
  "http",
  "json",
  "sql",
  "html",
  "xml",
  "uri",
]);

function toGoCase(name: string): string {
  return splitWords(name)
    .map((w) => (GO_INITIALISMS.has(w.toLowerCase()) ? w.toUpperCase() : cap(w)))
    .join("");
}

const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

const RUST_KEYWORDS = new Set([
  "as",
  "break",
  "const",
  "continue",
  "crate",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "Self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "dyn",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "macro",
  "override",
  "priv",
  "typeof",
  "unsized",
  "virtual",
  "yield",
  "try",
]);

interface FieldIdent {
  name: string;
  /** 元の列名から機械的な大小変換以上の変更が入った (記号の除去・予約語回避・重複回避など)。 */
  lossy: boolean;
}

/** 先頭が ASCII 英字 / `_` のみの素直な識別子か。 */
const CLEAN_IDENT = /^[A-Za-z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$/;

/** 列名を言語ごとに安全なフィールド名へ変換する。`used` には使用済みの名前を渡し、重複は連番で避ける。 */
function fieldIdent(orig: string, lang: TypeDefLang, naming: TypeDefNaming, used: Set<string>): FieldIdent {
  let lossy = !CLEAN_IDENT.test(orig);
  const goStyle = lang === "go";
  let name = goStyle
    ? toGoCase(orig)
    : naming === "camel" && namingApplies(lang)
      ? toCamelCase(orig)
      : toSnakeCase(orig);
  if (lang === "rust") name = toSnakeCase(orig);
  if (name === "") {
    name = goStyle ? "Field" : "field";
    lossy = true;
  }
  // 先頭が数字 / (Go は) ASCII 英字でないと識別子・エクスポートとして成立しない。
  // Python 系は `_` 始まりだと Pydantic v2 がフィールドとして扱わないため `col_` を付ける。
  if (goStyle ? !/^[A-Z]/.test(name) : /^\p{N}/u.test(name)) {
    name = goStyle
      ? `Col${name}`
      : lang === "python" || lang === "pythonPydantic"
        ? `col_${name}`
        : `_${name}`;
    lossy = true;
  }
  if (lang === "python" || lang === "pythonPydantic") {
    if (PYTHON_KEYWORDS.has(name)) {
      name = `${name}_`;
      lossy = true;
    }
  } else if (lang === "rust" && RUST_KEYWORDS.has(name)) {
    name = `${name}_`;
    lossy = true;
  }
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) {
    candidate = goStyle ? `${name}${n}` : `${name}_${n}`;
    lossy = true;
  }
  used.add(candidate);
  return { name: candidate, lossy };
}

/** テーブル名を型名 (PascalCase) へ変換する。 */
export function typeNameFor(table: string, lang: TypeDefLang): string {
  let name = lang === "go" ? toGoCase(table) : toPascalCase(table);
  if (name === "") name = "Table";
  if (/^\p{N}/u.test(name) || (lang === "go" && !/^[A-Z]/.test(name))) name = `T${name}`;
  return name;
}

// ---------------------------------------------------------------------------
// 3. 言語ごとの型表現
// ---------------------------------------------------------------------------

function tsType(ir: TypeIR): string {
  switch (ir.k) {
    case "int":
      return ir.bits === 64 && !ir.jsSafe ? "string" : "number";
    case "float":
      return "number";
    case "bool":
      return "boolean";
    case "json":
      return "unknown";
    case "enum":
      return ir.values.map((v) => JSON.stringify(v)).join(" | ");
    case "array": {
      if (!ir.of) return "unknown[]";
      const el = tsType(ir.of);
      return el.includes(" | ") ? `(${el})[]` : `${el}[]`;
    }
    default:
      // decimal / string / uuid / date / time / datetime / binary は JSON 越しの文字列表現。
      return "string";
  }
}

function zodType(ir: TypeIR): string {
  switch (ir.k) {
    case "int":
      return ir.bits === 64 && !ir.jsSafe ? "z.string()" : "z.number().int()";
    case "float":
      return "z.number()";
    case "bool":
      return "z.boolean()";
    case "json":
      return "z.unknown()";
    case "enum":
      return `z.enum([${ir.values.map((v) => JSON.stringify(v)).join(", ")}])`;
    case "array":
      return `z.array(${ir.of ? zodType(ir.of) : "z.unknown()"})`;
    default:
      return "z.string()";
  }
}

interface GoType {
  text: string;
  /** nil を取れる型 (スライス / RawMessage)。NULL を許す列でもポインタにしない。 */
  nilable: boolean;
}

function goType(ir: TypeIR, imports: Set<string>): GoType {
  switch (ir.k) {
    case "int":
      return { text: `${ir.unsigned ? "uint" : "int"}${ir.bits}`, nilable: false };
    case "float":
      return { text: `float${ir.bits}`, nilable: false };
    case "bool":
      return { text: "bool", nilable: false };
    case "date":
    case "datetime":
      imports.add("time");
      return { text: "time.Time", nilable: false };
    case "json":
      imports.add("encoding/json");
      return { text: "json.RawMessage", nilable: true };
    case "binary":
      return { text: "[]byte", nilable: true };
    case "array":
      return { text: `[]${ir.of ? goType(ir.of, imports).text : "any"}`, nilable: true };
    default:
      // decimal (精度を落とさない) / string / uuid / time (時刻のみ) / enum は string。
      return { text: "string", nilable: false };
  }
}

function rustType(ir: TypeIR, driver: string): string {
  switch (ir.k) {
    case "int":
      return `${ir.unsigned ? "u" : "i"}${ir.bits}`;
    case "float":
      return `f${ir.bits}`;
    case "decimal":
      // SQLite の NUMERIC / DECIMAL は REAL として保存され、sqlx は Decimal をデコードできない。
      return driver === "sqlite" ? "f64" : "rust_decimal::Decimal";
    case "bool":
      return "bool";
    case "uuid":
      return "uuid::Uuid";
    case "date":
      return "chrono::NaiveDate";
    case "time":
      return "chrono::NaiveTime";
    case "datetime":
      return ir.tz ? "chrono::DateTime<chrono::Utc>" : "chrono::NaiveDateTime";
    case "json":
      return "serde_json::Value";
    case "binary":
      return "Vec<u8>";
    case "array":
      return `Vec<${ir.of ? rustType(ir.of, driver) : "serde_json::Value"}>`;
    default:
      return "String";
  }
}

function pyType(ir: TypeIR, imports: Set<string>): string {
  switch (ir.k) {
    case "int":
      return "int";
    case "float":
      return "float";
    case "decimal":
      imports.add("import decimal as _decimal");
      return "_decimal.Decimal";
    case "bool":
      return "bool";
    case "uuid":
      imports.add("import uuid as _uuid");
      return "_uuid.UUID";
    case "date":
      imports.add("import datetime as _datetime");
      return "_datetime.date";
    case "time":
      imports.add("import datetime as _datetime");
      return "_datetime.time";
    case "datetime":
      imports.add("import datetime as _datetime");
      return "_datetime.datetime";
    case "json":
      imports.add("from typing import Any");
      return "Any";
    case "binary":
      return "bytes";
    case "enum":
      imports.add("from typing import Literal");
      return `Literal[${ir.values.map((v) => JSON.stringify(v)).join(", ")}]`;
    case "array": {
      if (!ir.of) {
        imports.add("from typing import Any");
        return "list[Any]";
      }
      return `list[${pyType(ir.of, imports)}]`;
    }
    default:
      return "str";
  }
}

// ---------------------------------------------------------------------------
// 4. コメント
// ---------------------------------------------------------------------------

function commentLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l, i, all) => l !== "" || (i > 0 && i < all.length - 1));
}

/** TS の JSDoc。1 行なら `/** x *\/`、複数行ならブロック。`*\/` は本文に出ても閉じないようエスケープする。 */
function jsDoc(lines: string[], indent: string): string[] {
  if (lines.length === 0) return [];
  const safe = lines.map((l) => l.replace(/\*\//g, "*\\/"));
  if (safe.length === 1) return [`${indent}/** ${safe[0]} */`];
  return [
    `${indent}/**`,
    ...safe.map((l) => (l === "" ? `${indent} *` : `${indent} * ${l}`)),
    `${indent} */`,
  ];
}

function prefixed(lines: string[], indent: string, marker: string): string[] {
  return lines.map((l) => (l === "" ? `${indent}${marker}` : `${indent}${marker} ${l}`));
}

function enumNote(ir: TypeIR): string[] {
  return ir.k === "enum" ? [`enum: ${ir.values.join(" | ").replace(/[\r\n]+/g, " ")}`] : [];
}

// ---------------------------------------------------------------------------
// 5. 生成
// ---------------------------------------------------------------------------

interface Prepared {
  col: TypeDefColumn;
  ir: TypeIR;
  ident: FieldIdent;
}

function prepare(table: TypeDefTable, o: TypeDefOptions): Prepared[] {
  const used = new Set<string>();
  return table.columns.map((col) => ({
    col,
    ir: columnIR(o.driver, col),
    ident: fieldIdent(col.name, o.lang, o.naming, used),
  }));
}

function genTypeScript(table: TypeDefTable, name: string, o: TypeDefOptions): string[] {
  const out = jsDoc(commentLines(table.comment), "");
  out.push(`export interface ${name} {`);
  for (const { col, ir, ident } of prepare(table, o)) {
    const doc = [...commentLines(col.comment), ...(ident.name !== col.name ? [`@column ${col.name}`] : [])];
    out.push(...jsDoc(doc, "  "));
    out.push(`  ${ident.name}: ${tsType(ir)}${col.nullable ? " | null" : ""};`);
  }
  out.push("}");
  return out;
}

function genZod(table: TypeDefTable, name: string, o: TypeDefOptions): string[] {
  const out = jsDoc(commentLines(table.comment), "");
  out.push(`export const ${name}Schema = z.object({`);
  for (const { col, ir, ident } of prepare(table, o)) {
    const doc = [...commentLines(col.comment), ...(ident.name !== col.name ? [`@column ${col.name}`] : [])];
    out.push(...jsDoc(doc, "  "));
    out.push(`  ${ident.name}: ${zodType(ir)}${col.nullable ? ".nullable()" : ""},`);
  }
  out.push("});");
  out.push(`export type ${name} = z.infer<typeof ${name}Schema>;`);
  return out;
}

function genGo(table: TypeDefTable, name: string, o: TypeDefOptions, imports: Set<string>): string[] {
  const rows = prepare(table, o).map(({ col, ir, ident }) => {
    const t = goType(ir, imports);
    const type = col.nullable && !t.nilable ? `*${t.text}` : t.text;
    // 生文字列のタグはバッククォートを含められないので、その列はタグを付けず元の名前をコメントに残す。
    const tagless = col.name.includes("`");
    const doc = [...commentLines(col.comment), ...enumNote(ir), ...(tagless ? [`column: ${col.name}`] : [])];
    return { doc, field: ident.name, type, tag: tagless ? "" : `\`db:${JSON.stringify(col.name)}\`` };
  });
  const nameW = Math.max(0, ...rows.map((r) => r.field.length));
  const typeW = Math.max(0, ...rows.map((r) => r.type.length));
  const out = prefixed(commentLines(table.comment), "", "//");
  out.push(`type ${name} struct {`);
  for (const r of rows) {
    out.push(...prefixed(r.doc, "\t", "//"));
    out.push(`\t${r.field.padEnd(nameW)} ${r.type.padEnd(typeW)} ${r.tag}`.trimEnd());
  }
  out.push("}");
  return out;
}

/** sqlx がそのままではデコードできない PostgreSQL の型への注記。 */
function rustNotes(driver: string, col: TypeDefColumn, ir: TypeIR): string[] {
  if (driver !== "postgres") return [];
  const base = baseTypeName(col.data_type.trim().toLowerCase());
  if (ir.k === "enum" || base === "user-defined") {
    return ["ENUM: sqlx cannot decode it as String directly; select it with a `::text` cast"];
  }
  if (base === "timetz" || base === "time with time zone") {
    return ["timetz: sqlx has no chrono mapping (PgTimeTz); select it with a `::text` cast"];
  }
  if (base === "money" || base === "smallmoney") {
    return ["money: sqlx decodes it as PgMoney, not Decimal; select it with a `::numeric` cast"];
  }
  return [];
}

function genRust(table: TypeDefTable, name: string, o: TypeDefOptions): string[] {
  const out = prefixed(commentLines(table.comment), "", "///");
  out.push("#[derive(Debug, Clone, sqlx::FromRow)]");
  out.push(`pub struct ${name} {`);
  for (const { col, ir, ident } of prepare(table, o)) {
    out.push(
      ...prefixed(
        [...commentLines(col.comment), ...enumNote(ir), ...rustNotes(o.driver, col, ir)],
        "    ",
        "///",
      ),
    );
    if (ident.name !== col.name) out.push(`    #[sqlx(rename = ${JSON.stringify(col.name)})]`);
    const type = rustType(ir, o.driver);
    out.push(`    pub ${ident.name}: ${col.nullable ? `Option<${type}>` : type},`);
  }
  out.push("}");
  return out;
}

/** Python の三連引用符 docstring に入れられるようエスケープする (`\\` / 末尾の `"` / `"""`)。 */
function escapeDocstring(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"$/, '\\"').replace(/"""/g, '\\"\\"\\"');
}

function genPython(
  table: TypeDefTable,
  name: string,
  o: TypeDefOptions,
  imports: Set<string>,
  pydantic: boolean,
): string[] {
  const rows = prepare(table, o).map((p) => {
    const base = pyType(p.ir, imports);
    if (p.col.nullable) imports.add("from typing import Optional");
    return { ...p, type: p.col.nullable ? `Optional[${base}]` : base };
  });
  const out: string[] = [];
  if (pydantic) {
    imports.add("from pydantic import BaseModel");
    out.push(`class ${name}(BaseModel):`);
  } else {
    imports.add("from dataclasses import dataclass");
    out.push("@dataclass", `class ${name}:`);
  }
  const doc = commentLines(table.comment);
  if (doc.length > 0) out.push(`    """${escapeDocstring(doc.join(" "))}"""`);
  const aliased = pydantic && rows.some((r) => r.ident.name !== r.col.name);
  if (aliased) {
    imports.add("from pydantic import ConfigDict");
    out.push("    model_config = ConfigDict(populate_by_name=True)");
  }
  for (const r of rows) {
    const note = [
      ...commentLines(r.col.comment),
      ...(!pydantic && r.ident.name !== r.col.name ? [`column: ${r.col.name}`] : []),
    ];
    out.push(...prefixed(note, "    ", "#:"));
    if (pydantic) {
      const alias = r.ident.name !== r.col.name ? `alias=${JSON.stringify(r.col.name)}` : "";
      if (alias) {
        imports.add("from pydantic import Field");
        out.push(`    ${r.ident.name}: ${r.type} = Field(${r.col.nullable ? "default=None, " : ""}${alias})`);
      } else {
        out.push(`    ${r.ident.name}: ${r.type}${r.col.nullable ? " = None" : ""}`);
      }
    } else {
      out.push(`    ${r.ident.name}: ${r.type}`);
    }
  }
  if (rows.length === 0 && doc.length === 0) out.push("    pass");
  return out;
}

/** import 群を並べて 1 ブロックにする (Python: `import x` → `from x import y`、`from` は 1 モジュール 1 行へ統合)。 */
function pythonImports(imports: Set<string>): string[] {
  const plain = [...imports].filter((i) => i.startsWith("import ")).sort();
  const from = new Map<string, string[]>();
  for (const i of imports) {
    const m = /^from (\S+) import (\S+)$/.exec(i);
    if (m) from.set(m[1] as string, [...(from.get(m[1] as string) ?? []), m[2] as string]);
  }
  const lines = [...from.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mod, names]) => `from ${mod} import ${names.sort().join(", ")}`);
  return [...plain, ...lines];
}

/**
 * テーブル群の型定義を 1 つの文字列にまとめる。複数テーブルは空行で区切り、import / use は先頭に 1 度だけ置く。
 * 型名が衝突したテーブルには連番を付ける。テーブルが無ければ空文字。
 */
export function generateTypeDefs(tables: TypeDefTable[], o: TypeDefOptions): string {
  if (tables.length === 0) return "";
  const imports = new Set<string>();
  const usedNames = new Set<string>();
  const blocks: string[] = [];
  for (const table of tables) {
    let name = typeNameFor(table.name, o.lang);
    for (let n = 2; usedNames.has(name); n++) name = `${typeNameFor(table.name, o.lang)}${n}`;
    usedNames.add(name);
    switch (o.lang) {
      case "typescript":
        blocks.push(genTypeScript(table, name, o).join("\n"));
        break;
      case "typescriptZod":
        blocks.push(genZod(table, name, o).join("\n"));
        break;
      case "go":
        blocks.push(genGo(table, name, o, imports).join("\n"));
        break;
      case "rust":
        blocks.push(genRust(table, name, o).join("\n"));
        break;
      case "python":
        blocks.push(genPython(table, name, o, imports, false).join("\n"));
        break;
      case "pythonPydantic":
        blocks.push(genPython(table, name, o, imports, true).join("\n"));
        break;
    }
  }
  let header = "";
  if (o.lang === "typescriptZod") header = 'import { z } from "zod";\n\n';
  else if (o.lang === "go" && imports.size > 0) {
    const list = [...imports].sort();
    header = `import (\n${list.map((i) => `\t${JSON.stringify(i)}`).join("\n")}\n)\n\n`;
  } else if (o.lang === "python" || o.lang === "pythonPydantic") {
    const lines = pythonImports(imports);
    header = lines.length > 0 ? `${lines.join("\n")}\n\n\n` : "";
  }
  const sep = o.lang === "python" || o.lang === "pythonPydantic" ? "\n\n\n" : "\n\n";
  return `${header}${blocks.join(sep)}\n`;
}
