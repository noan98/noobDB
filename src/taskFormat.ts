/**
 * タスクスケジューラ (#730) の表示用の純ロジック。副作用なし・`Date` は常に
 * 引数として明示的に渡す形にしてあるので `Vitest` で決定的にテストできる
 * (`sqlLint.ts` / `gridStats.ts` などと同じ方針)。
 */
import type { TaskAction, TaskSchedule } from "./api/tauri";
import type { I18nKey } from "./i18n";

/** 翻訳関数 (`i18n.t` と同じ形)。テストでは固定辞書を渡せる。 */
export type TaskT = (key: I18nKey, vars?: Record<string, string | number>) => string;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * `at` 時点での `timeZone` (省略時は実行環境のローカル) の UTC からの差 (分、東が正)。
 * DST のある地域では `at` の日付で値が変わるため、日付を必ず明示的に渡す。
 */
export function tzOffsetMinutes(at: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** 時・分 + 日付の繰り上がり (-1: 前日 / 0: 同日 / 1: 翌日)。 */
export interface ClockTime {
  hour: number;
  minute: number;
  dayShift: -1 | 0 | 1;
}

function shiftClock(hour: number, minute: number, deltaMinutes: number): ClockTime {
  const total = clamp(hour, 0, 23) * 60 + clamp(minute, 0, 59) + deltaMinutes;
  const day = Math.floor(total / 1440);
  const rem = total - day * 1440;
  return {
    hour: Math.floor(rem / 60),
    minute: rem % 60,
    dayShift: clamp(day, -1, 1) as -1 | 0 | 1,
  };
}

/** 保存形式 (UTC の時・分) → ローカル時刻。オフセットは基準日時 `at` のものを使う。 */
export function utcToLocalClock(hour: number, minute: number, at: Date, timeZone?: string): ClockTime {
  return shiftClock(hour, minute, tzOffsetMinutes(at, timeZone));
}

/** 入力 (ローカルの時・分) → 保存形式 (UTC の時・分)。`utcToLocalClock` の逆変換。 */
export function localToUtcClock(hour: number, minute: number, at: Date, timeZone?: string): ClockTime {
  return shiftClock(hour, minute, -tzOffsetMinutes(at, timeZone));
}

/** タイムゾーンの短い表記 ("JST" / "GMT+9" / "EDT")。取れなければ "UTC±hh:mm"。 */
export function timeZoneLabel(at: Date, locale?: string, timeZone?: string): string {
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    if (name) return name;
  } catch {
    // フォールバックへ
  }
  const off = tzOffsetMinutes(at, timeZone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export interface ScheduleDisplayOptions {
  /** オフセット計算の基準日時 (DST 対応)。一覧では次回実行日時を渡すと、DST をまたいでも次回実行日の時差で表示される。 */
  now?: Date;
  /** IANA タイムゾーン。省略時は実行環境のローカル (テストで固定するための口)。 */
  timeZone?: string;
  /** タイムゾーン略称の言語。 */
  locale?: string;
}

/** スケジュールの短い要約 ("30 分ごと" / "毎日 09:00 (JST)")。日次はローカル時刻に換算して表示する。 */
export function summarizeSchedule(
  schedule: TaskSchedule,
  t: TaskT,
  opts: ScheduleDisplayOptions = {},
): string {
  if (schedule.kind === "interval") {
    return t("taskSummaryInterval", { n: Math.max(1, schedule.minutes) });
  }
  const now = opts.now ?? new Date();
  const local = utcToLocalClock(schedule.hour, schedule.minute, now, opts.timeZone);
  return t("taskSummaryDaily", {
    time: formatClock(local.hour, local.minute),
    tz: timeZoneLabel(now, opts.locale, opts.timeZone),
  });
}

/** アクションの短い要約 ("Export (csv)" / "Dump (sales)")。 */
export function summarizeAction(action: TaskAction, t: TaskT): string {
  if (action.kind === "export_query") {
    return t("taskSummaryExport", { format: action.format });
  }
  if (action.kind === "run_assertions") {
    return action.assertion_ids.length === 0
      ? t("taskSummaryAssertionsAll")
      : t("taskSummaryAssertions", { n: action.assertion_ids.length });
  }
  if (action.kind === "timelapse_capture") {
    return t("taskSummaryTimelapse");
  }
  if (action.kind === "refresh_plan_watch") {
    return action.snippet_ids.length === 0
      ? t("taskSummaryPlanWatchAll")
      : t("taskSummaryPlanWatch", { n: action.snippet_ids.length });
  }
  return t("taskSummaryDump", { database: action.database || "?" });
}

/**
 * `next_run_at` (RFC3339 または null) と現在時刻から「あとどれくらいで実行
 * されるか」の相対表現を返す。壊れた/欠落した値は空文字列 (呼び出し側が
 * ダッシュ等へフォールバックする)。過去の時刻 (未起動中に過ぎた等) は
 * "due" を返す。
 */
export function relativeNextRun(nextRunAt: string | null, now: Date, t: TaskT): string {
  if (!nextRunAt) return "";
  const target = Date.parse(nextRunAt);
  if (!Number.isFinite(target)) return "";
  const diffMs = target - now.getTime();
  if (diffMs <= 0) return t("taskRelDue");
  // 各単位は切り捨て (floor) で統一する: "1 min" と表示したら実際には 1 分
  // *以上* 経っている (切り上げ/四捨五入だと "1 min" 表示のすぐ後に発火して
  // 体感とズレる)。分未満は "<1 min" で明示する。
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t("taskRelLessThanMinute");
  if (mins < 60) return t("taskRelMinutes", { n: mins });
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return t("taskRelHours", { n: hours });
  const days = Math.floor(diffMs / 86_400_000);
  return t("taskRelDays", { n: days });
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
export function sortTasksForDisplay<T extends { enabled: boolean; next_run_at: string | null; name: string }>(
  tasks: T[],
): T[] {
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

/** アサーション 1 件ぶんの推移 (トレンド表示用)。 */
export interface AssertionTrend {
  assertionId: string;
  /** 直近の実行時点の名前。 */
  name: string;
  /** 古い → 新しい順の合否 (最大 `maxDots` 件)。 */
  dots: boolean[];
  /** 直近の observed (実行エラーなら null)。 */
  lastObserved: number | null;
  lastError: string | null;
  /** `dots` の範囲での合格率 (0〜1)。 */
  passRate: number;
}

/**
 * `list_assertion_runs` の結果 (新しい順) をアサーションごとにまとめる。表示順は
 * 直近で失敗しているものを先頭に、次に名前順。純関数。
 */
export function buildAssertionTrends(
  records: ReadonlyArray<{
    assertion_id: string;
    assertion_name: string;
    passed: boolean;
    observed: number | null;
    error: string | null;
  }>,
  maxDots = 20,
): AssertionTrend[] {
  const byId = new Map<string, (typeof records)[number][]>();
  for (const r of records) {
    const list = byId.get(r.assertion_id) ?? [];
    if (list.length < maxDots) list.push(r);
    byId.set(r.assertion_id, list);
  }
  const trends: AssertionTrend[] = [];
  for (const [assertionId, list] of byId) {
    const latest = list[0];
    const passedCount = list.filter((r) => r.passed).length;
    trends.push({
      assertionId,
      name: latest.assertion_name,
      dots: list.map((r) => r.passed).reverse(),
      lastObserved: latest.observed,
      lastError: latest.error,
      passRate: passedCount / list.length,
    });
  }
  trends.sort((a, b) => {
    const af = a.dots[a.dots.length - 1] ? 1 : 0;
    const bf = b.dots[b.dots.length - 1] ? 1 : 0;
    if (af !== bf) return af - bf;
    return a.name.localeCompare(b.name);
  });
  return trends;
}
