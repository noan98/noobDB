import type { ProcessInfo } from "../api/tauri";
import type { LiveField } from "./liveDiff";

/** 値変化フラッシュ (#1022) の対象列。 */
export type ProcessLiveField = "command" | "state" | "time" | "query";

/**
 * プロセス一覧で「前回ポーリングから変化した」とみなす列の判定 (#1022)。
 *
 * 経過時間 (`time`) は実行中の文なら毎ティック単調に増えるのが正常で、それを
 * 毎回光らせると列全体が点滅し続けて何も読み取れない。そこで**巻き戻った
 * (= 同じ接続で新しい文が始まった)** ときと、報告の有無が切り替わったときだけ
 * 変化とみなす。単調な増加は `CountUp` の数値補間で「進んでいる」ことを示す。
 */
export const PROCESS_LIVE_FIELDS: readonly LiveField<ProcessInfo, ProcessLiveField>[] = [
  { name: "command", changed: (a, b) => (a.command ?? null) !== (b.command ?? null) },
  { name: "state", changed: (a, b) => (a.state ?? null) !== (b.state ?? null) },
  {
    name: "time",
    changed: (a, b) => {
      const before = a.time_secs ?? null;
      const after = b.time_secs ?? null;
      if (before === null || after === null) return before !== after;
      return after < before;
    },
  },
  { name: "query", changed: (a, b) => (a.query ?? null) !== (b.query ?? null) },
];

/** プロセス行の安定 key (#1022)。ポーリング間で同じ接続は同じ key を保つ。 */
export function processKey(p: ProcessInfo): number {
  return p.id;
}

/**
 * プロセスモニタパネルの純ロジック。レンダリングから切り離してユニットテスト
 * できるよう、`erDiagram.ts` と同じ方針で分離している。
 */

/**
 * 経過秒の人間向け表示。`null` (エンジンが報告しない) は "–"。
 * 60 秒未満は "37s"、1 時間未満は "2m 05s"、それ以上は "3h 04m"。
 */
export function formatProcessTime(secs: number | null): string {
  if (secs == null || secs < 0) return "–";
  if (secs < 60) return `${secs}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}m ${pad(secs % 60)}s`;
  }
  return `${Math.floor(secs / 3600)}h ${pad(Math.floor((secs % 3600) / 60))}m`;
}

/**
 * 再取得後のプロセス一覧に存在する id だけを選択に残す。kill や自然終了で
 * 消えたプロセスの選択を持ち越すと、次の kill が別プロセス (id 再利用) を
 * 巻き込みかねないため、リフレッシュごとに必ず刈り込む。
 */
export function pruneSelection(
  selected: ReadonlySet<number>,
  processes: ProcessInfo[],
): Set<number> {
  const alive = new Set(processes.map((p) => p.id));
  const next = new Set<number>();
  for (const id of selected) {
    if (alive.has(id)) next.add(id);
  }
  return next;
}

/**
 * グリッドのクエリ列に出す 1 行要約。改行・連続空白を畳み、`max` 文字で
 * 切り詰めて "…" を付ける。空/NULL は "–"。
 */
export function summarizeQuery(query: string | null, max = 200): string {
  const oneLine = (query ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (oneLine === "") return "–";
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}
