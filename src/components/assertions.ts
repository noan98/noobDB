/**
 * データ品質アサーション (#742) の純ロジック。副作用なし (DOM / IPC に触れない)
 * なので Vitest で単体テストできる。
 *
 * - **フォーム ⇔ ルール変換**: 編集モーダルの入力 (すべて文字列) を
 *   `SaveAssertionRequest` へ組み立て、足りない入力をフィールド単位のエラーコードで
 *   返す (`draftToRequest`)。バックエンドも保存時に同じ検証をする (`db::assertions::
 *   validate`) が、モーダルを閉じる前に理由をフィールドの横に出すためにここでも見る。
 * - **一括検証の順次実行**: `runAssertionsSequentially` は 1 件ずつ実行し、1 件の
 *   失敗 (エラー/タイムアウト) で止めず、中止要求は次の 1 件の前で効かせる。
 *   IPC 呼び出しは引数で注入するので、順序と中止の規則を実 DB なしで固定できる。
 * - **表示整形**: ルールの要約・件数の見せ方を i18n キー + パラメータで返す
 *   (`advisor.ts` と同じ「バックエンドは散文を出さない」流儀)。
 *
 * ルール → SQL の変換はバックエンド (`db::assertions::build_sql`) が単一ソースで、
 * フロントは SQL を組み立てない (プレビューも `preview_assertion_sql` を呼ぶ)。
 */
import type {
  Assertion,
  AssertionOutcome,
  AssertionRule,
  RowCountOp,
  SaveAssertionRequest,
  SnippetScope,
} from "../api/tauri";
import type { I18nKey } from "../i18n";

export type AssertionRuleKind = AssertionRule["kind"];

/** ルール種別の表示順 (編集モーダルのセレクト)。 */
export const ASSERTION_RULE_KINDS: readonly AssertionRuleKind[] = [
  "not_null",
  "unique",
  "accepted_values",
  "range",
  "referential",
  "row_count",
];

export const ROW_COUNT_OPS: readonly RowCountOp[] = ["gt", "gte", "lt", "lte", "eq", "between"];

export type AssertionScopeKind = "profile" | "group" | "any";

/** 編集モーダルの入力状態。すべて文字列のまま持ち、保存時にルールへ組み立てる。 */
export interface AssertionDraft {
  id?: string;
  name: string;
  scopeKind: AssertionScopeKind;
  schema: string;
  table: string;
  kind: AssertionRuleKind;
  /** not_null / accepted_values / range の対象列。 */
  column: string;
  /** unique / referential の列 (カンマ・改行区切り)。 */
  columns: string;
  /** accepted_values の許可値 (1 行 1 値。値にカンマを含めてよいよう改行区切り)。 */
  values: string;
  min: string;
  max: string;
  refSchema: string;
  refTable: string;
  /** referential の参照先列 (カンマ・改行区切り、`columns` と位置で対応)。 */
  refColumns: string;
  op: RowCountOp;
  count: string;
  countMax: string;
}

/** フィールド単位の入力エラー。モーダルが対応するフィールドの横に出す。 */
export type AssertionDraftError =
  | "name"
  | "table"
  | "column"
  | "columns"
  | "values"
  | "bounds"
  | "refTable"
  | "refColumns"
  | "count"
  | "countMax"
  | "scopeGroup";

export function emptyAssertionDraft(init?: { schema?: string | null; table?: string | null }): AssertionDraft {
  return {
    name: "",
    scopeKind: "profile",
    schema: init?.schema ?? "",
    table: init?.table ?? "",
    kind: "not_null",
    column: "",
    columns: "",
    values: "",
    min: "",
    max: "",
    refSchema: "",
    refTable: "",
    refColumns: "",
    op: "gt",
    count: "0",
    countMax: "",
  };
}

/** 保存済みアサーションを編集モーダルの入力状態へ戻す (`draftToRequest` の逆)。 */
export function draftFromAssertion(a: Assertion): AssertionDraft {
  const d: AssertionDraft = {
    ...emptyAssertionDraft({ schema: a.schema, table: a.table }),
    id: a.id,
    name: a.name,
    scopeKind: a.scope.kind,
    kind: a.rule.kind,
  };
  const r = a.rule;
  switch (r.kind) {
    case "not_null":
      d.column = r.column;
      break;
    case "unique":
      d.columns = r.columns.join(", ");
      break;
    case "accepted_values":
      d.column = r.column;
      d.values = r.values.join("\n");
      break;
    case "range":
      d.column = r.column;
      d.min = r.min ?? "";
      d.max = r.max ?? "";
      break;
    case "referential":
      d.columns = r.columns.join(", ");
      d.refSchema = r.ref_schema ?? "";
      d.refTable = r.ref_table;
      d.refColumns = r.ref_columns.join(", ");
      break;
    case "row_count":
      d.op = r.op;
      d.count = String(r.value);
      d.countMax = r.max === null ? "" : String(r.max);
      break;
  }
  return d;
}

/** カンマ・改行区切りの列リスト。前後の空白を落とし、空要素は捨てる。 */
export function parseColumnList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 1 行 1 値の許可値リスト。前後の空白を落とし、空行は捨てる。 */
export function parseValueList(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 非負の整数 (行数) として読めるか。読めなければ `null`。 */
function parseCount(text: string): number | null {
  const s = text.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function blankToNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

export type DraftRuleResult =
  | { ok: true; rule: AssertionRule }
  | { ok: false; error: AssertionDraftError };

/**
 * ルール部分だけを組み立てる (名前・スコープは見ない)。プレビューはこれが通った
 * ときだけバックエンドへ問い合わせる。
 */
export function draftToRule(d: AssertionDraft): DraftRuleResult {
  if (!d.table.trim()) return { ok: false, error: "table" };
  const column = d.column.trim();
  switch (d.kind) {
    case "not_null":
      if (!column) return { ok: false, error: "column" };
      return { ok: true, rule: { kind: "not_null", column } };
    case "unique": {
      const columns = parseColumnList(d.columns);
      if (columns.length === 0) return { ok: false, error: "columns" };
      return { ok: true, rule: { kind: "unique", columns } };
    }
    case "accepted_values": {
      if (!column) return { ok: false, error: "column" };
      const values = parseValueList(d.values);
      if (values.length === 0) return { ok: false, error: "values" };
      return { ok: true, rule: { kind: "accepted_values", column, values } };
    }
    case "range": {
      if (!column) return { ok: false, error: "column" };
      const min = blankToNull(d.min);
      const max = blankToNull(d.max);
      if (min === null && max === null) return { ok: false, error: "bounds" };
      return { ok: true, rule: { kind: "range", column, min, max } };
    }
    case "referential": {
      const columns = parseColumnList(d.columns);
      if (columns.length === 0) return { ok: false, error: "columns" };
      const refTable = d.refTable.trim();
      if (!refTable) return { ok: false, error: "refTable" };
      const refColumns = parseColumnList(d.refColumns);
      if (refColumns.length !== columns.length) return { ok: false, error: "refColumns" };
      return {
        ok: true,
        rule: {
          kind: "referential",
          columns,
          ref_schema: blankToNull(d.refSchema),
          ref_table: refTable,
          ref_columns: refColumns,
        },
      };
    }
    case "row_count": {
      const value = parseCount(d.count);
      if (value === null) return { ok: false, error: "count" };
      if (d.op !== "between") return { ok: true, rule: { kind: "row_count", op: d.op, value, max: null } };
      const max = parseCount(d.countMax);
      if (max === null || max < value) return { ok: false, error: "countMax" };
      return { ok: true, rule: { kind: "row_count", op: d.op, value, max } };
    }
  }
}

export type DraftRequestResult =
  | { ok: true; req: SaveAssertionRequest }
  | { ok: false; error: AssertionDraftError };

/**
 * 入力状態を保存リクエストへ組み立てる。スコープは接続中のプロファイルから決まる
 * (`profile` はそのプロファイル、`group` はそのグループ、`any` は全接続)。
 */
export function draftToRequest(
  d: AssertionDraft,
  profile: { id: string; group?: string | null } | null,
): DraftRequestResult {
  const name = d.name.trim();
  if (!name) return { ok: false, error: "name" };
  const rule = draftToRule(d);
  if (!rule.ok) return rule;
  let scope: SnippetScope;
  if (d.scopeKind === "any" || !profile) {
    scope = { kind: "any" };
  } else if (d.scopeKind === "group") {
    const group = (profile.group ?? "").trim();
    if (!group) return { ok: false, error: "scopeGroup" };
    scope = { kind: "group", group };
  } else {
    scope = { kind: "profile", profile_id: profile.id };
  }
  return {
    ok: true,
    req: {
      ...(d.id ? { id: d.id } : {}),
      name,
      scope,
      schema: blankToNull(d.schema),
      table: d.table.trim(),
      rule: rule.rule,
    },
  };
}

/** i18n キー + 埋め込みパラメータ。 */
export interface I18nText {
  key: I18nKey;
  params?: Record<string, string>;
}

export const RULE_KIND_LABEL_KEY: Record<AssertionRuleKind, I18nKey> = {
  not_null: "assertRuleNotNull",
  unique: "assertRuleUnique",
  accepted_values: "assertRuleAcceptedValues",
  range: "assertRuleRange",
  referential: "assertRuleReferential",
  row_count: "assertRuleRowCount",
};

export const ROW_COUNT_OP_SYMBOL: Record<RowCountOp, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  eq: "=",
  between: "between",
};

/** 一覧に出す 1 行の要約 (対象と条件)。 */
export function describeRule(a: Pick<Assertion, "schema" | "table" | "rule">): I18nText {
  const table = a.schema ? `${a.schema}.${a.table}` : a.table;
  const r = a.rule;
  switch (r.kind) {
    case "not_null":
      return { key: "assertDescNotNull", params: { table, column: r.column } };
    case "unique":
      return { key: "assertDescUnique", params: { table, columns: r.columns.join(", ") } };
    case "accepted_values":
      return {
        key: "assertDescAcceptedValues",
        params: { table, column: r.column, values: r.values.join(", ") },
      };
    case "range":
      return {
        key: "assertDescRange",
        params: { table, column: r.column, min: r.min ?? "−∞", max: r.max ?? "+∞" },
      };
    case "referential": {
      const target = r.ref_schema ? `${r.ref_schema}.${r.ref_table}` : r.ref_table;
      return {
        key: "assertDescReferential",
        params: {
          table,
          columns: r.columns.join(", "),
          target,
          refColumns: r.ref_columns.join(", "),
        },
      };
    }
    case "row_count":
      return r.op === "between"
        ? { key: "assertDescRowCountBetween", params: { table, min: String(r.value), max: String(r.max ?? r.value) } }
        : { key: "assertDescRowCount", params: { table, op: ROW_COUNT_OP_SYMBOL[r.op], value: String(r.value) } };
  }
}

/** 結果の件数表示。`row_count` は「行数」、それ以外は「違反件数」。 */
export function observedText(rule: AssertionRule, outcome: AssertionOutcome): I18nText {
  return rule.kind === "row_count"
    ? { key: "assertObservedRows", params: { count: String(outcome.observed) } }
    : { key: "assertObservedViolations", params: { count: String(outcome.observed) } };
}

/** 1 件の検証状態。未実行は Map に載らない。 */
export type AssertionRunState =
  | { status: "running" }
  | { status: "passed"; outcome: AssertionOutcome }
  | { status: "failed"; outcome: AssertionOutcome }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export function stateFromOutcome(outcome: AssertionOutcome): AssertionRunState {
  return outcome.passed ? { status: "passed", outcome } : { status: "failed", outcome };
}

/**
 * `ids` を 1 件ずつ順に検証する。
 *
 * - 1 件のエラー (列が無い・タイムアウト等) は `error` として記録し、次へ進む。
 * - `isCancelled()` が true になったら、まだ始めていない残りを `cancelled` にして
 *   抜ける (実行中の 1 件はバックエンドのタイムアウトまで待つ)。
 */
export async function runAssertionsSequentially(
  ids: readonly string[],
  run: (id: string) => Promise<AssertionOutcome>,
  onUpdate: (id: string, state: AssertionRunState) => void,
  isCancelled: () => boolean,
): Promise<void> {
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (isCancelled()) {
      for (const rest of ids.slice(i)) onUpdate(rest, { status: "cancelled" });
      return;
    }
    onUpdate(id, { status: "running" });
    try {
      onUpdate(id, stateFromOutcome(await run(id)));
    } catch (e) {
      onUpdate(id, { status: "error", error: String(e) });
    }
  }
}

export interface AssertionRunSummary {
  passed: number;
  failed: number;
  errored: number;
  total: number;
}

/** 一覧上部に出す集計。`ids` に含まれない (別スコープの) 結果は数えない。 */
export function summarizeRuns(
  ids: readonly string[],
  states: ReadonlyMap<string, AssertionRunState>,
): AssertionRunSummary {
  const s: AssertionRunSummary = { passed: 0, failed: 0, errored: 0, total: ids.length };
  for (const id of ids) {
    const st = states.get(id);
    if (st?.status === "passed") s.passed++;
    else if (st?.status === "failed") s.failed++;
    else if (st?.status === "error") s.errored++;
  }
  return s;
}
