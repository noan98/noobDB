/**
 * タスクスケジューラ (#730) の表示用の純ロジック。副作用なし・`Date` は常に
 * 引数として明示的に渡す形にしてあるので `Vitest` で決定的にテストできる
 * (`sqlLint.ts` / `gridStats.ts` などと同じ方針)。
 */
import type { TaskAction, TaskSchedule } from "./api/tauri";

/** スケジュールの短い要約 ("30 分ごと" / "毎日 09:00 (UTC)")。 */
export function summarizeSchedule(schedule: TaskSchedule): string {
  if (schedule.kind === "interval") {
    return `${Math.max(1, schedule.minutes)} min`;
  }
  const h = String(Math.min(23, Math.max(0, schedule.hour))).padStart(2, "0");
  const m = String(Math.min(59, Math.max(0, schedule.minute))).padStart(2, "0");
  return `daily ${h}:${m} UTC`;
}

/** アクションの短い要約 ("Export (csv)" / "Dump (sales)")。 */
export function summarizeAction(action: TaskAction): string {
  if (action.kind === "export_query") {
    return `export (${action.format})`;
  }
  return `dump (${action.database || "?"})`;
}

/**
 * `next_run_at` (RFC3339 または null) と現在時刻から「あとどれくらいで実行
 * されるか」の相対表現を返す。壊れた/欠落した値は空文字列 (呼び出し側が
 * ダッシュ等へフォールバックする)。過去の時刻 (未起動中に過ぎた等) は
 * "due" を返す。
 */
export function relativeNextRun(nextRunAt: string | null, now: Date): string {
  if (!nextRunAt) return "";
  const target = Date.parse(nextRunAt);
  if (!Number.isFinite(target)) return "";
  const diffMs = target - now.getTime();
  if (diffMs <= 0) return "due";
  // 各単位は切り捨て (floor) で統一する: "1 min" と表示したら実際には 1 分
  // *以上* 経っている (切り上げ/四捨五入だと "1 min" 表示のすぐ後に発火して
  // 体感とズレる)。分未満は "<1 min" で明示する。
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "<1 min";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(diffMs / 86_400_000);
  return `${days} d`;
}

/** `output_path` テンプレートの `{date}`/`{datetime}` プレースホルダを展開する
 *  純ロジック。バックエンドの `tasks::executor::resolve_output_path` と同じ書式
 *  (UTC、`YYYY-MM-DD` / `YYYYMMDD-HHMMSS`) をプレビュー表示のためにミラーする。 */
export function previewOutputPath(template: string, now: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const date = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  const datetime = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours(),
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return template.split("{date}").join(date).split("{datetime}").join(datetime);
}

/** タスク一覧のソート順: 有効なタスクを先に、その中では次回実行が近い順。
 *  無効なタスクは末尾にまとめ、名前順にする (混ざると探しにくいため)。 */
export function sortTasksForDisplay<
  T extends { enabled: boolean; next_run_at: string | null; name: string },
>(tasks: T[]): T[] {
  const enabled = tasks.filter((t) => t.enabled);
  const disabled = tasks.filter((t) => !t.enabled);
  enabled.sort((a, b) => {
    const at = a.next_run_at ? Date.parse(a.next_run_at) : Infinity;
    const bt = b.next_run_at ? Date.parse(b.next_run_at) : Infinity;
    if (at !== bt) return at - bt;
    return a.name.localeCompare(b.name);
  });
  disabled.sort((a, b) => a.name.localeCompare(b.name));
  return [...enabled, ...disabled];
}
