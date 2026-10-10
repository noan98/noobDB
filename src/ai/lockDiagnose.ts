// ロック待ち・長時間実行クエリの AI 解説 (#1478) の純ロジック: 対象プロセスの選び方・
// 関連テーブルの決定・プロンプト組み立て・応答パース。副作用 (IPC・状態管理) は
// `components/AiLockDiagnose.tsx` が持つ。
// 送るのは待機関係・実行時間・クエリ本文 (送信範囲 / `maskLiterals` に従う)・関係テーブルの
// スキーマだけ。行データ・セル値・接続元ホストは扱わない。KILL は AI から実行しない。

import { z } from "zod";
import type { ProcessInfo } from "../api/tauri";
import {
  dialectLabel,
  ERROR_EXPLAIN_MAX_TABLES,
  extractTableRefs,
  sqlForAi,
  type ExplainColumn,
  type TableRef,
} from "./errorExplain";
import { IMPACT_RISKS } from "./impactAnalysis";

/** 1 回の解説に載せるプロセス数の上限 (プロンプトの肥大化防止)。 */
export const LOCK_DIAGNOSE_MAX_PROCESSES = 12;
/** 長時間実行とみなす最低経過秒数。 */
export const LOCK_DIAGNOSE_LONG_RUNNING_SECS = 5;
/** 長時間実行の候補として載せる最大件数。 */
export const LOCK_DIAGNOSE_MAX_LONG_RUNNING = 5;

/** 解説の対象を何から決めたか。 */
export type LockDiagnoseScope = "selection" | "chain" | "longRunning";

export interface LockDiagnoseTargets {
  scope: LockDiagnoseScope;
  /** 対象プロセス (最大 `LOCK_DIAGNOSE_MAX_PROCESSES`)。 */
  processes: ProcessInfo[];
  /** 上限で切り捨てた件数。 */
  omitted: number;
}

/** 待機していない・動いていない接続 (Sleep / idle など)。長時間実行の候補にしない。 */
function isIdleCommand(command: string | null): boolean {
  const c = (command ?? "").toLowerCase();
  return c === "sleep" || c === "idle" || c === "daemon" || c === "";
}

/** 起点から `blocked_by` を双方向に辿った連結成分 (一覧に存在するプロセスのみ)。 */
function chainComponent(all: readonly ProcessInfo[], seeds: readonly number[]): ProcessInfo[] {
  const byId = new Map(all.map((p) => [p.id, p] as const));
  const neighbors = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    (neighbors.get(a) ?? neighbors.set(a, new Set()).get(a))?.add(b);
    (neighbors.get(b) ?? neighbors.set(b, new Set()).get(b))?.add(a);
  };
  for (const p of all) for (const b of p.blocked_by ?? []) link(p.id, b);
  const seen = new Set<number>();
  const order: number[] = [];
  const stack = seeds.filter((id) => byId.has(id));
  while (stack.length > 0) {
    const id = stack.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const n of neighbors.get(id) ?? []) if (!seen.has(n)) stack.push(n);
  }
  return order.map((id) => byId.get(id)).filter((p): p is ProcessInfo => p !== undefined);
}

function capTargets(scope: LockDiagnoseScope, list: ProcessInfo[]): LockDiagnoseTargets {
  const processes = list.slice(0, LOCK_DIAGNOSE_MAX_PROCESSES);
  return { scope, processes, omitted: list.length - processes.length };
}

/**
 * 解説の対象を決める。優先順位は 選択中 > 待機チェーン > 長時間実行クエリ。
 * - 選択中: 選んだプロセスに待機関係でつながるプロセスも含める (誰が誰を待つかを説明できるように)。
 * - 待機チェーン: 一覧のうち `blocked_by` でつながっているプロセスすべて。
 * - 長時間実行: 動作中で `LOCK_DIAGNOSE_LONG_RUNNING_SECS` 以上、自アプリの接続を除いた上位。
 * 対象が無ければ null。
 */
export function selectLockDiagnoseTargets(
  processes: readonly ProcessInfo[],
  selectedIds: ReadonlySet<number>,
): LockDiagnoseTargets | null {
  const selected = processes.filter((p) => selectedIds.has(p.id)).map((p) => p.id);
  if (selected.length > 0) {
    // 選択したものを先頭に、つながるプロセスを後ろへ (重複なし)。
    const comp = chainComponent(processes, selected);
    const head = comp.filter((p) => selectedIds.has(p.id));
    const rest = comp.filter((p) => !selectedIds.has(p.id));
    const picked = processes.filter((p) => selectedIds.has(p.id));
    const merged = [...new Map([...head, ...picked, ...rest].map((p) => [p.id, p] as const)).values()];
    return capTargets("selection", merged);
  }
  const chained = processes.filter((p) => (p.blocked_by ?? []).length > 0).map((p) => p.id);
  if (chained.length > 0) {
    const comp = chainComponent(processes, chained);
    // 待たせている側 (根) を先頭に寄せる: 自分は待っておらず他に待たれているものが先。
    const waiting = (p: ProcessInfo) => (p.blocked_by ?? []).length > 0;
    comp.sort((a, b) => Number(waiting(a)) - Number(waiting(b)));
    return capTargets("chain", comp);
  }
  const long = processes
    .filter(
      (p) =>
        !p.is_self &&
        !isIdleCommand(p.command) &&
        p.query_summary !== null &&
        (p.time_secs ?? 0) >= LOCK_DIAGNOSE_LONG_RUNNING_SECS,
    )
    .sort((a, b) => (b.time_secs ?? 0) - (a.time_secs ?? 0))
    .slice(0, LOCK_DIAGNOSE_MAX_LONG_RUNNING);
  if (long.length > 0) return capTargets("longRunning", long);
  return null;
}

/** プロンプトに載せる 1 プロセス (接続元ホストは含めない)。`query` は未マスクの本文。 */
export interface LockDiagnoseProcess {
  id: number;
  user: string | null;
  database: string | null;
  command: string | null;
  state: string | null;
  timeSecs: number | null;
  query: string | null;
  blockedBy: number[];
  isSelf: boolean;
}

export function toLockDiagnoseProcess(p: ProcessInfo, fullQuery: string | null): LockDiagnoseProcess {
  return {
    id: p.id,
    user: p.user,
    database: p.database,
    command: p.command,
    state: p.state,
    timeSecs: p.time_secs,
    query: fullQuery ?? p.query_summary,
    blockedBy: [...new Set(p.blocked_by ?? [])].filter((b) => b !== p.id),
    isSelf: p.is_self,
  };
}

/**
 * クエリ本文から関連テーブルを集める (重複なし・上限 `ERROR_EXPLAIN_MAX_TABLES`)。
 * 修飾が無いテーブルはそのプロセスの接続先 DB で引く。
 */
export function lockDiagnoseTableRefs(processes: readonly LockDiagnoseProcess[], driver: string): TableRef[] {
  const seen = new Set<string>();
  const out: TableRef[] = [];
  for (const p of processes) {
    if (!p.query) continue;
    for (const ref of extractTableRefs(p.query, driver)) {
      if (out.length >= ERROR_EXPLAIN_MAX_TABLES) return out;
      const resolved: TableRef = { database: ref.database ?? p.database, table: ref.table };
      const key = `${resolved.database ?? ""}.${resolved.table}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

export interface LockDiagnoseTable {
  name: string;
  columns: ExplainColumn[];
  /** エンジン統計の行数推定。取れなければ null。インデックスはキー列 (`columns[].key`) から読む。 */
  estimatedRows: number | null;
}

export interface LockDiagnoseInput {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  scope: LockDiagnoseScope;
  processes: LockDiagnoseProcess[];
  /** 上限で切り捨てた関連プロセス数。 */
  omitted: number;
  tables: LockDiagnoseTable[];
  /** 設定 `ai.maskLiterals`。true なら SQL 内のリテラルを潰して送る。 */
  maskLiterals: boolean;
  locale: "ja" | "en";
}

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const LOCK_DIAGNOSE_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      waits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            session_id: { type: "number" },
            waiting_for: { type: "array", items: { type: "number" } },
            detail: { type: "string" },
          },
          required: ["session_id", "waiting_for", "detail"],
          additionalProperties: false,
        },
      },
      stop_candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            session_id: { type: "number" },
            impact: { type: "string", enum: [...IMPACT_RISKS] },
            reason: { type: "string" },
          },
          required: ["session_id", "impact", "reason"],
          additionalProperties: false,
        },
      },
      prevention: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "waits", "stop_candidates", "prevention"],
    additionalProperties: false,
  },
} as const;

const responseSchema = z.object({
  summary: z.string(),
  waits: z.array(
    z.object({ session_id: z.number(), waiting_for: z.array(z.number()), detail: z.string() }),
  ),
  stop_candidates: z.array(
    z.object({ session_id: z.number(), impact: z.enum(IMPACT_RISKS), reason: z.string() }),
  ),
  prevention: z.array(z.string()),
});
export type LockDiagnoseResponse = z.infer<typeof responseSchema>;

export type ParsedLockDiagnose =
  | { ok: true; value: LockDiagnoseResponse }
  | { ok: false; raw: string };

/** ストリームで結合した本文を JSON として解釈する。失敗時は本文をそのまま返す。 */
export function parseLockDiagnoseResponse(text: string): ParsedLockDiagnose {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = responseSchema.safeParse(JSON.parse(body));
    if (parsed.success) return { ok: true, value: parsed.data };
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

export function buildLockDiagnoseSystem(locale: "ja" | "en"): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    "You are a database expert diagnosing lock waits and long-running queries from a process list snapshot.",
    `Write all text fields in ${lang}.`,
    "Answer only with the JSON object described by the schema.",
    "summary: what is happening in plain words (who is waiting for whom, and what the root blocker is doing).",
    "waits: one entry per waiting session; waiting_for lists the session ids it waits for; detail says what it is waiting on. Use an empty array when nothing waits.",
    "stop_candidates: sessions that could be stopped, ordered from the smallest impact. impact is high / medium / low and reason explains why (e.g. the blocker is idle in a transaction, killing a writer rolls back its work). Never suggest stopping a session marked as the app's own connection.",
    "prevention: concrete ways to prevent recurrence (missing indexes, shorter transactions, consistent lock order, batching); an empty array when none.",
    "You cannot kill anything. The user decides and operates the existing kill buttons; do not output SQL or commands that kill sessions.",
    "Use only the information provided; never invent session ids, data values, tables or indexes that are not listed.",
    "Literal values in the SQL may be blanked out for privacy; keep that in mind.",
  ].join("\n");
}

const SCOPE_DESCRIPTION: Record<LockDiagnoseScope, string> = {
  selection: "sessions selected by the user, plus sessions linked to them by lock waits",
  chain: "all sessions involved in lock wait chains",
  longRunning: "the longest-running active queries",
};

/** ユーザプロンプトを組み立てる。行データ・接続元ホストは含めない。 */
export function buildLockDiagnosePrompt(input: LockDiagnoseInput): string {
  const lines: string[] = [];
  lines.push(`Dialect: ${dialectLabel(input.driver)}`);
  lines.push(`Target: ${SCOPE_DESCRIPTION[input.scope]}`);
  if (input.omitted > 0) lines.push(`(${input.omitted} more related sessions omitted)`);
  const ids = new Set(input.processes.map((p) => p.id));
  const waits = input.processes.filter((p) => p.blockedBy.length > 0);
  lines.push("");
  lines.push("Lock waits (waiter -> blocker):");
  if (waits.length === 0) lines.push("- none reported");
  for (const p of waits) {
    for (const b of p.blockedBy) {
      lines.push(`- #${p.id} waits for #${b}${ids.has(b) ? "" : " (not in this list)"}`);
    }
  }
  lines.push("");
  lines.push("Sessions:");
  for (const p of input.processes) {
    const meta = [
      `user=${p.user ?? "-"}`,
      `db=${p.database ?? "-"}`,
      `command=${p.command ?? "-"}`,
      `state=${p.state ?? "-"}`,
      `running=${p.timeSecs !== null ? `${p.timeSecs}s` : "unknown"}`,
      p.isSelf ? "this-app-connection" : "",
    ].filter(Boolean);
    lines.push(`- #${p.id} (${meta.join(", ")})`);
    if (p.query) {
      lines.push(
        input.maskLiterals ? "  SQL (string literals and comments are blanked):" : "  SQL:",
      );
      for (const l of sqlForAi(p.query, input.driver, input.maskLiterals).split("\n")) {
        lines.push(`    ${l}`);
      }
    } else {
      lines.push("  SQL: (none)");
    }
  }
  if (input.tables.length > 0) {
    lines.push("");
    lines.push("Related tables:");
    for (const t of input.tables) {
      lines.push(`- ${t.name} (estimated rows: ${t.estimatedRows ?? "unknown"})`);
      for (const c of t.columns) {
        const flags = [
          c.key ? `key=${c.key}` : "",
          c.nullable ? "nullable" : "not null",
          c.referenced_table ? `-> ${c.referenced_table}.${c.referenced_column ?? "?"}` : "",
        ].filter(Boolean);
        lines.push(`    ${c.name} ${c.data_type} (${flags.join(", ")})`);
      }
    }
  }
  return lines.join("\n");
}
