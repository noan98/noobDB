import type { ForeignKey, TableColumnInfo } from "../api/tauri";
import { mdEscape } from "./exportPreview";

/**
 * DB スキーマを AI (Claude など) に伝えるための Markdown を生成する純ロジック。
 * IPC 取得 (`SchemaExportModal`) と整形を分離し、ここは副作用なしでテストする。
 *
 * 出力はロケールに依存しない英語固定とする: AI への入力として言語を安定させ、
 * テストも決定的にするため (生成日時も同じ理由で含めない)。
 */

/** 1 テーブル分の入力。`columns === null` は列詳細 (describeTable) の取得失敗。 */
export interface SchemaExportTable {
  name: string;
  columns: TableColumnInfo[] | null;
}

export interface SchemaExportInput {
  database: string;
  driver: string;
  tables: SchemaExportTable[];
  foreignKeys: ForeignKey[];
}

/**
 * 選択テーブル集合を、外部キーで紐付くテーブルの推移的閉包へ拡張する。
 * FK は参照の向きに関係なく双方向 (参照先・参照元の両方) に辿る: AI にクエリを
 * 書かせる用途では親テーブルにも子テーブルにも意味があるため。戻り値は
 * `selected` 自体を含む (存在しないテーブル名もそのまま残るが、呼び出し側が
 * 実テーブル一覧と突き合わせて絞るので無害)。
 */
export function expandWithFkRelated(
  selected: readonly string[],
  foreignKeys: readonly ForeignKey[],
): Set<string> {
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const fk of foreignKeys) {
    if (fk.table === fk.referenced_table) continue; // 自己参照はループさせない
    link(fk.table, fk.referenced_table);
    link(fk.referenced_table, fk.table);
  }
  const seen = new Set(selected);
  const queue = [...seen];
  for (let i = 0; i < queue.length; i++) {
    for (const next of adjacency.get(queue[i]) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** カラム表のうち、全行で空なら省略する任意列の定義。 */
const OPTIONAL_COLUMNS: {
  header: string;
  value: (c: TableColumnInfo) => string;
}[] = [
  { header: "Key", value: (c) => c.key },
  { header: "Default", value: (c) => c.default ?? "" },
  { header: "Extra", value: (c) => c.extra },
];

function buildColumnsTable(columns: TableColumnInfo[]): string {
  const optional = OPTIONAL_COLUMNS.filter((oc) =>
    columns.some((c) => oc.value(c) !== ""),
  );
  const headers = ["Column", "Type", "Nullable", ...optional.map((oc) => oc.header)];
  let out = "| " + headers.join(" | ") + " |\n";
  out += "|" + " --- |".repeat(headers.length) + "\n";
  for (const c of columns) {
    const cells = [
      mdEscape(c.name),
      mdEscape(c.data_type),
      c.nullable ? "YES" : "NO",
      ...optional.map((oc) => mdEscape(oc.value(c))),
    ];
    out += "| " + cells.join(" | ") + " |\n";
  }
  return out;
}

/**
 * 1 テーブル分の FK を箇条書きの行 (先頭の `- ` なし) に変換する。複合キーは
 * `constraint_name` でグループ化して `(a, b) → other (x, y)`、単一キーは
 * `a → other.x`。参照先カラムが解決できないときはテーブル名のみを出す。
 */
function fkLines(fks: ForeignKey[]): string[] {
  const groups: ForeignKey[][] = [];
  const byConstraint = new Map<string, ForeignKey[]>();
  for (const fk of fks) {
    const key = fk.constraint_name;
    if (key !== null && key !== "") {
      const group = byConstraint.get(key);
      if (group) {
        group.push(fk);
        continue;
      }
      const created = [fk];
      byConstraint.set(key, created);
      groups.push(created);
    } else {
      groups.push([fk]);
    }
  }
  return groups.map((group) => {
    if (group.length === 1) {
      const fk = group[0];
      const target = fk.referenced_column
        ? `${fk.referenced_table}.${fk.referenced_column}`
        : fk.referenced_table;
      return `${fk.column} → ${target}`;
    }
    const cols = group.map((fk) => fk.column).join(", ");
    const refCols = group.every((fk) => fk.referenced_column)
      ? ` (${group.map((fk) => fk.referenced_column).join(", ")})`
      : "";
    return `(${cols}) → ${group[0].referenced_table}${refCols}`;
  });
}

/**
 * スキーマ全体 (または選択済みテーブル群) の Markdown を生成する。
 *
 * - ヘッダは `# <db> (<driver>) — N tables` の 1 行のみ。
 * - テーブルごとに見出し + カラム表。Key / Default / Extra 列はそのテーブルの
 *   全行で空なら省略する (トークン節約)。
 * - FK は各テーブル直下の箇条書き (`input.foreignKeys` のうち該当テーブルが
 *   参照元のもの)。参照先が `tables` に含まれなくてもそのまま表記する
 *   (AI への文脈として有用なため)。
 */
export function buildSchemaMarkdown(input: SchemaExportInput): string {
  const { database, driver, tables, foreignKeys } = input;
  const fkByTable = new Map<string, ForeignKey[]>();
  for (const fk of foreignKeys) {
    const list = fkByTable.get(fk.table);
    if (list) list.push(fk);
    else fkByTable.set(fk.table, [fk]);
  }
  const count = tables.length;
  let out = `# ${database} (${driver}) — ${count} ${count === 1 ? "table" : "tables"}\n`;
  for (const table of tables) {
    out += `\n## ${mdEscape(table.name)}\n\n`;
    out +=
      table.columns === null
        ? "_column details unavailable_\n"
        : buildColumnsTable(table.columns);
    const fks = fkByTable.get(table.name);
    if (fks && fks.length > 0) {
      out += "\nForeign keys:\n";
      for (const line of fkLines(fks)) out += `- ${line}\n`;
    }
  }
  return out;
}

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, "0");
}

function timestamp(now: Date): string {
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "_" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function sanitizeForFilename(s: string): string {
  // Windows/macOS/Linux のファイル名で使えない文字をアンダースコアへ。末尾の
  // ドット/空白は落とす (Windows の制約)。ExportModal と同じ方針。
  return s
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/[ .]+$/, "")
    .trim();
}

/** 既定の保存ファイル名 (`schema_<db>_<timestamp>.md`)。 */
export function defaultSchemaFilename(database: string, now = new Date()): string {
  const db = sanitizeForFilename(database) || "database";
  return `schema_${db}_${timestamp(now)}.md`;
}
