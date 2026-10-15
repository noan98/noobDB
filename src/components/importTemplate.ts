// 取り込みマッピングテンプレート (#1623) の純ロジック。保存済みの設定を画面の状態へ
// 戻す変換と、画面の状態からテンプレートを組み立てる変換。IPC は `api.*ImportTemplate`。

import type {
  ImportConflictMode,
  ImportErrorMode,
  ImportFormat,
  ImportTemplate,
  ImportTemplateColumn,
} from "../api/tauri";

export type DelimiterChoice = "," | "\t" | ";";
export type NullMode = "none" | "empty" | "custom";

const FORMATS: ImportFormat[] = ["csv", "json", "ndjson", "xlsx"];

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** 保存済みの NULL トークンを画面の選択 (なし / 空 / 任意) に直す。 */
export function nullModeOf(token: string | null | undefined): { mode: NullMode; custom: string } {
  if (token === null || token === undefined) return { mode: "none", custom: "NULL" };
  if (token === "") return { mode: "empty", custom: "NULL" };
  return { mode: "custom", custom: token };
}

export interface TemplateSettings {
  format: ImportFormat;
  delimiter: DelimiterChoice;
  quote: string;
  hasHeader: boolean;
  nullMode: NullMode;
  nullCustom: string;
  encoding: string;
  sheet: string;
  errorMode: ImportErrorMode;
  conflictMode: ImportConflictMode;
  keyColumns: string[];
}

/** テンプレートの設定を画面の状態に直す。未知の値は既定へ丸める (手編集・将来の版への備え)。 */
export function templateSettings(tpl: ImportTemplate): TemplateSettings {
  const nul = nullModeOf(tpl.nullToken);
  const format = FORMATS.includes(tpl.format as ImportFormat) ? (tpl.format as ImportFormat) : "csv";
  const delimiter: DelimiterChoice =
    tpl.delimiter === "\t" || tpl.delimiter === ";" || tpl.delimiter === "," ? tpl.delimiter : ",";
  const conflictMode: ImportConflictMode =
    tpl.conflictMode === "skip" || tpl.conflictMode === "update" ? tpl.conflictMode : "insert";
  return {
    format,
    delimiter,
    quote: tpl.quote.length === 1 ? tpl.quote : '"',
    hasHeader: tpl.hasHeader,
    nullMode: nul.mode,
    nullCustom: nul.custom,
    encoding: tpl.encoding || "utf-8",
    sheet: tpl.sheet ?? "",
    errorMode: tpl.errorMode === "skip" ? "skip" : "abort",
    conflictMode,
    keyColumns: tpl.keyColumns,
  };
}

/**
 * 保存済みの対応を、今のファイルの見出しに当てはめる。ヘッダーがあるファイルでは保存した
 * 見出し名で位置を引き直し (列の並びが変わっても追従)、見つからなければ未対応付けにする。
 * ヘッダー無しのファイル、または保存時に見出しを持たなかった列は保存時の位置を使う
 * (ファイルの幅の範囲内のときだけ)。テンプレートに無い列は `null` (取り込まない)。
 */
export function templateToMapping(
  tpl: Pick<ImportTemplate, "mapping">,
  headers: string[],
  namedHeaders: boolean,
  tableColumnNames: string[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const name of tableColumnNames) {
    const entry = tpl.mapping.find((m) => m.column === name);
    if (!entry) {
      out[name] = null;
      continue;
    }
    let idx = -1;
    if (namedHeaders && entry.header) {
      // 見出しのあるファイルでは見出し名だけで引く。見つからないときに保存時の位置へ
      // 戻すと別の列を黙って取り込みうるので、未対応付け (取り込まない) にする。
      const want = norm(entry.header);
      idx = headers.findIndex((h) => norm(h) === want);
    } else if (entry.csvIndex < headers.length) {
      idx = entry.csvIndex;
    }
    out[name] = idx >= 0 ? idx : null;
  }
  return out;
}

export interface BuildTemplateArgs {
  profileId: string;
  database: string;
  table: string;
  settings: Omit<TemplateSettings, "nullMode" | "nullCustom"> & { nullToken: string | null };
  /** 取り込み先の列 → ファイルの列位置 (マッピングされた列だけ)。 */
  mapping: { column: string; csvIndex: number }[];
  headers: string[];
  namedHeaders: boolean;
}

/** 画面の状態から保存用のテンプレートを作る (ID と時刻はバックエンドが決める)。 */
export function buildImportTemplate(a: BuildTemplateArgs): ImportTemplate {
  const mapping: ImportTemplateColumn[] = a.mapping.map((m) => ({
    column: m.column,
    header: a.namedHeaders ? (a.headers[m.csvIndex] ?? null) : null,
    csvIndex: m.csvIndex,
  }));
  return {
    id: "",
    profileId: a.profileId,
    database: a.database || null,
    table: a.table,
    format: a.settings.format,
    delimiter: a.settings.delimiter,
    quote: a.settings.quote,
    hasHeader: a.settings.hasHeader,
    nullToken: a.settings.nullToken,
    encoding: a.settings.encoding,
    sheet: a.settings.sheet || null,
    conflictMode: a.settings.conflictMode,
    errorMode: a.settings.errorMode,
    keyColumns: a.settings.keyColumns,
    mapping,
    updatedAtMs: 0,
  };
}
