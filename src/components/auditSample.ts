import type { SemanticRole } from "../semanticColors";
import { classifyTypeName, normalizeTypeForClassify, type CellKind } from "./cellTypeMeta";

/**
 * 監査トリガーのウィザード (#2324) が出す「記録される行の見本」の組み立て (純関数)。
 * 実データは取りに行かず、列名と型ファミリーから作るダミー値だけで、選んだ操作ごとに
 * 監査表の 1 行 (`op` / `pk` / `old_row` / `new_row`) がどう残るかを表す。
 * 形は `src-tauri/src/db/audit_trigger.rs` の生成物に合わせる
 * (INSERT は old_row が NULL、DELETE は new_row が NULL、pk は主キー列のみ)。
 */

export type AuditSampleOp = "insert" | "update" | "delete";

export const AUDIT_SAMPLE_OPS: readonly AuditSampleOp[] = ["insert", "update", "delete"];

/** 操作 → 意味色。差分の語彙 (`diffStatusColors.ts`: 追加 = success / 変更 = warning / 削除 = danger) と揃える。 */
export const OP_ROLE: Record<AuditSampleOp, SemanticRole> = {
  insert: "success",
  update: "warning",
  delete: "danger",
};

/** 見本の入力。表の列 (名前・DB カタログの型名・主キーか)。 */
export interface SampleColumn {
  name: string;
  dataType: string;
  primaryKey: boolean;
}

/** 見本の入力のうち、オプションから使う部分。 */
export interface SampleOptions {
  insert: boolean;
  update: boolean;
  delete: boolean;
  exclude_columns: readonly string[];
  skip_unchanged_update: boolean;
}

export interface SampleCell {
  name: string;
  kind: CellKind;
  /** 型ファミリーから作ったダミー値 (`<int>` など)。 */
  value: string;
  /** 記録しない列 (見本では打ち消し線で薄く残す)。 */
  excluded: boolean;
}

export interface SampleCard {
  op: AuditSampleOp;
  /** 主キー列。主キーが無い表は null (pk は NULL で記録される)。 */
  pk: SampleCell[] | null;
  /** 変更前の行。INSERT は null。 */
  oldRow: SampleCell[] | null;
  /** 変更後の行。DELETE は null。 */
  newRow: SampleCell[] | null;
  /** 「値が変わらない UPDATE は記録しない」が効く UPDATE か。 */
  skipsUnchanged: boolean;
}

const PLACEHOLDERS: Record<CellKind, string> = {
  number: "<int>",
  decimal: "<decimal>",
  bool: "<bool>",
  date: "<date>",
  time: "<time>",
  json: "<json>",
  enum: "<enum>",
  binary: "<binary>",
  string: "<text>",
};

/** 型ファミリー → ダミー値。 */
export function dummyValue(kind: CellKind): string {
  return PLACEHOLDERS[kind];
}

function cellsOf(columns: readonly SampleColumn[], excluded: ReadonlySet<string>): SampleCell[] {
  return columns.map((c) => {
    const kind = classifyTypeName(normalizeTypeForClassify(c.dataType));
    return { name: c.name, kind, value: dummyValue(kind), excluded: excluded.has(c.name) };
  });
}

/** 選んだ操作ごとの見本カード (INSERT → UPDATE → DELETE の順)。 */
export function buildSampleCards(columns: readonly SampleColumn[], options: SampleOptions): SampleCard[] {
  const excluded = new Set(options.exclude_columns);
  const row = cellsOf(columns, excluded);
  const pkColumns = columns.filter((c) => c.primaryKey);
  // pk には主キーを常に入れる (除外列でも消えない)。
  const pk = pkColumns.length > 0 ? cellsOf(pkColumns, new Set()) : null;
  return AUDIT_SAMPLE_OPS.filter((op) => options[op]).map((op) => ({
    op,
    pk,
    oldRow: op === "insert" ? null : row,
    newRow: op === "delete" ? null : row,
    skipsUnchanged: op === "update" && options.skip_unchanged_update,
  }));
}

/** 選んだ操作 (流れの図のチップ)。 */
export function selectedOps(options: SampleOptions): AuditSampleOp[] {
  return AUDIT_SAMPLE_OPS.filter((op) => options[op]);
}
