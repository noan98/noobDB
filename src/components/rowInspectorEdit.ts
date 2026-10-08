/**
 * 行インスペクタのフォーム編集 (#1394) の純ロジック。副作用なし。
 *
 * 判定の単一ソースは既存の結果グリッド経路 (`cellEdit.ts` / `typedEditor.ts`) で、
 * ここではそれを「1 行を縦に並べたフォーム」向けに組み替えるだけ:
 * - どの列を編集できるか (グリッドと同じ列判定 + マスク中の列は除外)
 * - 行全体が編集できる状態か (保留中のグリッド編集・削除予定・読み込み中は不可)
 * - 編集開始時の値からフォームの下書きを作る / 下書きから変更差分を抜く
 * - 型別の入力コントロールの選び方 (`resolveTypedEditor` と同じ規則)
 *
 * 確定した差分は `{ [colIdx]: 生の入力文字列 }` の形で、グリッドの保留編集と同じ
 * 表現になる。SQL リテラル化と適用は App 側の `applyEditsForTab` (= `bulk_update_cells`)
 * が担うので、ここでは書き込み経路を持たない。
 */

import type { CellValue, Column } from "../api/tauri";
import type { I18nKey } from "../i18n";
import { editIsNoop } from "./cellEdit";
import {
  boolOptions,
  resolveTypedEditor,
  type NativeInputType,
} from "./typedEditor";

/** 下書き: 列インデックス → 編集中の生の入力文字列 (グリッドの保留編集と同じ表現)。 */
export type InspectorDraft = Record<number, string>;

/**
 * 列ごとの入力コントロール。文字列入力・複数行 (textarea)・ネイティブ日時入力・
 * 真偽値セレクタのいずれか。
 */
export type InspectorControl =
  | { kind: "text" }
  | { kind: "textarea" }
  | { kind: "native"; inputType: NativeInputType }
  | { kind: "bool"; options: string[] };

/**
 * 列ごとに「フォームで編集してよいか」を決める。グリッドで編集できない列
 * (PK・BLOB・識別列) は `editableColumns` で既に false、マスク中の列はここで落とす
 * (実値を見せない列は編集させない、#1069)。`gridEditable` が false (読み取り専用 /
 * PK 欠如 / 編集対象外のタブ) なら全列 false。
 */
export function inspectorEditableColumns(input: {
  columnCount: number;
  gridEditable: boolean;
  editableColumns?: boolean[];
  maskedColumns?: boolean[];
}): boolean[] {
  return Array.from({ length: input.columnCount }, (_, i) =>
    input.gridEditable &&
    !!input.editableColumns?.[i] &&
    !input.maskedColumns?.[i],
  );
}

/**
 * 行単位で編集を始められない理由。優先順位は「読み込み中 → 削除予定 → 保留中の
 * グリッド編集」。どれにも当たらなければ `null` (編集できる)。
 *
 * - 読み込み中: 行がまだ確定していない (ストリーミング中) ので値を固定できない。
 * - 一括適用の実行中: グリッドの Apply と並行して同じ行を書くと、結果の取り込みが
 *   食い違うため待たせる。
 * - 削除予定: 削除と更新を同じ行に併存させない。
 * - 保留中のグリッド編集: インスペクタの「適用」は行単位の差分だけを送るため、
 *   既存の保留を黙って上書き・取り込みしない。先にグリッド側で適用/破棄してもらう。
 */
export function inspectorRowEditBlock(input: {
  streaming: boolean;
  applying: boolean;
  pendingDelete: boolean;
  hasPendingEdit: boolean;
}): I18nKey | null {
  if (input.streaming) return "rowInspectorEditBlockedStreaming";
  if (input.applying) return "rowInspectorEditBlockedApplying";
  if (input.pendingDelete) return "rowInspectorEditBlockedDelete";
  if (input.hasPendingEdit) return "rowInspectorEditBlockedPending";
  return null;
}

/** NULL は下書きでは文字列 `NULL` (グリッドの編集欄と同じ表示と入力規則)。 */
const NULL_TEXT = "NULL";

/** 編集開始時の値から下書きを作る。NULL は `NULL`、それ以外は文字列表現。 */
export function draftFromRow(values: CellValue[], columnCount: number): InspectorDraft {
  const draft: InspectorDraft = {};
  for (let i = 0; i < columnCount; i++) {
    const v = values[i];
    draft[i] = v === null || v === undefined ? NULL_TEXT : String(v);
  }
  return draft;
}

/** 長文を入れる型 (TEXT / CLOB / JSON / XML 系)。1 行入力では改行が消えるので複数行欄にする。 */
export function isMultilineColumn(typeName: string): boolean {
  return /TEXT|CLOB|JSON|XML/i.test(typeName);
}

/**
 * 1 列の入力コントロールを決める。`resolveTypedEditor` の規則に従い、表現できない
 * 値 (真偽値の想定外表記など) は文字列入力に落として値を失わない。改行を含む値や
 * 長文型は複数行欄にして改行を保つ。`original` は編集開始時の値 (NULL は `null`)。
 */
export function inspectorControlFor(typeName: string, original: CellValue): InspectorControl {
  const start = original === null || original === undefined ? "" : String(original);
  const typed = resolveTypedEditor(typeName, start);
  if (typed?.control === "native") return { kind: "native", inputType: typed.inputType };
  if (typed?.control === "bool") {
    // 初期値がどの選択肢にも一致しない ("TRUE" など) なら文字列入力のまま。
    if (start === "" || boolOptions(start).includes(start)) {
      return { kind: "bool", options: boolOptions(start) };
    }
  }
  if (isMultilineColumn(typeName) || start.includes("\n")) return { kind: "textarea" };
  return { kind: "text" };
}

/**
 * 編集開始後に、行の値 (base = 編集開始時の値) が変わったか。自動リフレッシュや
 * グリッドの Apply で同じ行が更新されたときに、古い差分を送らないための判定。
 */
export function rowChangedSince(base: CellValue[], current: CellValue[], columnCount: number): boolean {
  for (let i = 0; i < columnCount; i++) {
    const a = base[i] ?? null;
    const b = current[i] ?? null;
    if (a === null || b === null) {
      if (a !== b) return true;
      continue;
    }
    if (String(a) !== String(b)) return true;
  }
  return false;
}

/** 変更差分と、その中の検証エラー。 */
export interface InspectorEditResult {
  /** 元の値から変わった編集可能な列だけ。値は生の入力文字列。 */
  edits: Record<number, string>;
  /** 検証に落ちた列 → i18n キー。ここに 1 つでもあれば適用させない。 */
  errors: Record<number, I18nKey>;
}

/**
 * 下書きと編集開始時の値を比べ、変更差分と検証エラーを返す。
 *
 * - 編集不可の列は無視する (下書きに値があっても送らない)。
 * - 操作していない列 (下書きが編集開始時の下書き `initial` と同じ) は触らない。
 *   文字列 "NULL" を持つ列を SQL NULL に化けさせないため、これを先に除外する。
 * - 元の値 `base` と同じ結果になる入力は差分に含めない (`editIsNoop`、NULL の再入力や
 *   `0` と `0.0` 相当など)。グリッドのセル編集と同じ判定。
 * - 数値は文字列のまま扱い Number 化しない。64bit 整数の精度を落とさないため、
 *   比較も `cellValueFromInput` 経由の文字列比較に任せる。
 */
export function collectInspectorEdits(input: {
  columns: Column[];
  /** 編集開始時の行の値 (差分の基準)。 */
  base: CellValue[];
  /** 編集開始時の下書き (`draftFromRow(base)`)。これと同じ列は未操作として扱う。 */
  initial: InspectorDraft;
  draft: InspectorDraft;
  editable: boolean[];
  validate: (colIdx: number, raw: string) => I18nKey | null;
}): InspectorEditResult {
  const edits: Record<number, string> = {};
  const errors: Record<number, I18nKey> = {};
  input.columns.forEach((col, i) => {
    if (!input.editable[i]) return;
    const raw = input.draft[i];
    if (raw === undefined) return;
    if (raw === input.initial[i]) return;
    const current = input.base[i] ?? null;
    if (editIsNoop(raw, col, current)) return;
    const err = input.validate(i, raw);
    if (err) {
      errors[i] = err;
      return;
    }
    edits[i] = raw;
  });
  return { edits, errors };
}
