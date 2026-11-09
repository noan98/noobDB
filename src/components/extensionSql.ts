import { quoteIdentFor } from "./sqlDialect";

/**
 * PostgreSQL の拡張機能 (EXTENSION) の `CREATE / ALTER / DROP EXTENSION` の組み立て (#2160)。
 * 純関数にして、識別子の引用・オプションの付け方・破壊的操作の判定をテストで固定する。実行は通常の
 * クエリ経路 (`run_query`) を通るので、read_only の拒否はバックエンドが行う。
 */

export type ExtensionAction = "install" | "update" | "drop";

export interface ExtensionActionOptions {
  /** 導入先のスキーマ (空なら指定しない = 既定のスキーマ)。導入のみ。 */
  schema: string;
  /** CASCADE を付ける。導入では依存する拡張も導入、削除では依存するオブジェクトも削除する。 */
  cascade: boolean;
}

/** 文字列リテラル。 */
function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** `CREATE EXTENSION` の文 (末尾の `;` なし)。 */
export function buildCreateExtensionSql(name: string, opts: ExtensionActionOptions): string {
  const schema = opts.schema.trim();
  return [
    `CREATE EXTENSION IF NOT EXISTS ${quoteIdentFor("postgres", name)}`,
    schema !== "" ? `SCHEMA ${quoteIdentFor("postgres", schema)}` : null,
    opts.cascade ? "CASCADE" : null,
  ]
    .filter((p) => p !== null)
    .join(" ");
}

/** `ALTER EXTENSION ... UPDATE` の文。`version` を渡すとそのバージョンへ (省略時は既定のバージョンへ)。 */
export function buildUpdateExtensionSql(name: string, version?: string | null): string {
  const to = version ? ` TO ${quoteLiteral(version)}` : "";
  return `ALTER EXTENSION ${quoteIdentFor("postgres", name)} UPDATE${to}`;
}

/** `DROP EXTENSION` の文。CASCADE を付けない既定では、依存するオブジェクトがあれば PostgreSQL が失敗させる。 */
export function buildDropExtensionSql(name: string, cascade: boolean): string {
  return `DROP EXTENSION ${quoteIdentFor("postgres", name)}${cascade ? " CASCADE" : ""}`;
}

export function buildExtensionSql(
  action: ExtensionAction,
  name: string,
  opts: ExtensionActionOptions,
  version?: string | null,
): string {
  switch (action) {
    case "install":
      return buildCreateExtensionSql(name, opts);
    case "update":
      return buildUpdateExtensionSql(name, version);
    case "drop":
      return buildDropExtensionSql(name, opts.cascade);
  }
}

/** 削除は破壊的 (依存オブジェクトや、その拡張の型を使う列のデータに及びうる)。 */
export function isDestructiveExtensionAction(action: ExtensionAction): boolean {
  return action === "drop";
}

/**
 * `CREATE EXTENSION` だけでは動かず、`shared_preload_libraries` への追記とサーバ再起動が要る拡張。
 * 導入済みでもライブラリが読み込まれていなければ機能しないので、一覧に注記を出す。
 */
const NEEDS_PRELOAD = new Set(["pg_stat_statements", "auto_explain", "pg_cron", "pgaudit", "timescaledb"]);

export function needsPreload(name: string): boolean {
  return NEEDS_PRELOAD.has(name);
}

/** `shared_preload_libraries` に含まれているか (`$libdir/` などの接頭辞は無視)。 */
export function isPreloaded(name: string, libraries: readonly string[]): boolean {
  return libraries.some((l) => l.replace(/^.*\//, "") === name);
}

/** 一覧の絞り込み。 */
export type ExtensionFilter = "all" | "installed" | "available" | "updatable";

export function matchesExtensionFilter(
  e: { installed_version: string | null; updatable: boolean },
  filter: ExtensionFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "installed":
      return e.installed_version !== null;
    case "available":
      return e.installed_version === null;
    case "updatable":
      return e.updatable;
  }
}

/** 削除の巻き添えになる依存オブジェクトの種別。見出しの並び順 (データが消える列が先頭)。 */
export const EXTENSION_DEPENDENT_KINDS = [
  "column",
  "table",
  "view",
  "materialized_view",
  "function",
  "procedure",
  "index",
  "constraint",
  "trigger",
  "default",
  "sequence",
  "type",
  "rule",
  "extension",
  "other",
] as const;

export type ExtensionDependentKind = (typeof EXTENSION_DEPENDENT_KINDS)[number];

export interface ExtensionDependentGroup<T> {
  kind: ExtensionDependentKind;
  items: T[];
}

/**
 * 依存オブジェクトを種別ごとにまとめる (#2177)。並びは `EXTENSION_DEPENDENT_KINDS` の順で、
 * 件数 0 の種別は出さない。未知の種別は `other` に寄せる。各グループ内の順序は入力のまま。
 */
export function groupExtensionDependents<T extends { kind: string }>(
  items: readonly T[],
): ExtensionDependentGroup<T>[] {
  const known = new Set<string>(EXTENSION_DEPENDENT_KINDS);
  const buckets = new Map<ExtensionDependentKind, T[]>();
  for (const item of items) {
    const kind = (known.has(item.kind) ? item.kind : "other") as ExtensionDependentKind;
    const list = buckets.get(kind);
    if (list) list.push(item);
    else buckets.set(kind, [item]);
  }
  return EXTENSION_DEPENDENT_KINDS.flatMap((kind) => {
    const list = buckets.get(kind);
    return list ? [{ kind, items: list }] : [];
  });
}

/** 依存オブジェクト 1 件の表示名: `schema.table.name` (無い部分は省く)。 */
export function formatExtensionDependent(d: {
  schema: string | null;
  table: string | null;
  name: string;
}): string {
  return [d.schema, d.table, d.name].filter((p): p is string => p !== null && p !== "").join(".");
}
