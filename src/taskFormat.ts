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

// タスク一覧は行ごとに時差・TZ 表記を引くので、Intl.DateTimeFormat (生成が高い) は
// timeZone / locale をキーにモジュール内でキャッシュする。
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
const labelFormatters = new Map<string, Intl.DateTimeFormat>();

/** キャッシュを捨てる。実行環境の既定タイムゾーンはキャッシュ生成時に固定されるため、テストが `process.env.TZ` を切り替えるときに使う。 */
export function clearTaskFormatCache(): void {
  offsetFormatters.clear();
  labelFormatters.clear();
}

function cached(
  cache: Map<string, Intl.DateTimeFormat>,
  key: string,
  make: () => Intl.DateTimeFormat,
): Intl.DateTimeFormat {
  let f = cache.get(key);
  if (!f) {
    f = make();
    cache.set(key, f);
  }
  return f;
}

function offsetFormatter(timeZone?: string): Intl.DateTimeFormat {
  return cached(
    offsetFormatters,
    timeZone ?? "",
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      }),
  );
}

/**
 * `at` 時点での `timeZone` (省略時は実行環境のローカル) の UTC からの差 (分、東が正)。
 * DST のある地域では `at` の日付で値が変わるため、日付を必ず明示的に渡す。
 */
export function tzOffsetMinutes(at: Date, timeZone?: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(at);
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
    const name = cached(
      labelFormatters,
      `${locale ?? ""}\u0000${timeZone ?? ""}`,
      () => new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }),
    )
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
  const mask = (schedule.weekdays ?? 0) & ALL_WEEKDAYS_MASK;
  if (schedule.timezone == null && mask === 0) {
    // 旧データ (UTC 保存): 実行環境のローカル時刻に換算して表示する。
    const now = opts.now ?? new Date();
    const local = utcToLocalClock(schedule.hour, schedule.minute, now, opts.timeZone);
    return t("taskSummaryDaily", {
      time: formatClock(local.hour, local.minute),
      tz: timeZoneLabel(now, opts.locale, opts.timeZone),
    });
  }
  // タイムゾーン指定あり (#1621): 保存した時刻をその IANA 名のまま示す。
  const time = formatClock(clamp(schedule.hour, 0, 23), clamp(schedule.minute, 0, 59));
  const tz = schedule.timezone ?? "UTC";
  if (mask === 0 || mask === ALL_WEEKDAYS_MASK) return t("taskSummaryDailyTz", { time, tz });
  if (mask === WORKDAYS_MASK) return t("taskSummaryWeekdaysTz", { time, tz });
  const labels = weekdayLabels(opts.locale);
  const days = weekdaysToFlags(mask)
    .flatMap((on, i) => (on ? [labels[i]] : []))
    .join(", ");
  return t("taskSummaryDaysTz", { days, time, tz });
}

// --- 日次スケジュールの編集用ドラフト (#1621) ---

/** 曜日マスク: 月 = bit0 … 日 = bit6。バックエンドの `ALL_WEEKDAYS` と同じ。 */
export const ALL_WEEKDAYS_MASK = 0b111_1111;
/** 平日 (月〜金)。 */
export const WORKDAYS_MASK = 0b001_1111;

/** 端末の IANA タイムゾーン名。取れなければ UTC。 */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 選択肢に出すタイムゾーン名。端末の TZ と UTC を先頭に、`Intl.supportedValuesOf` の一覧を続ける。 */
export function timeZoneChoices(device: string = deviceTimeZone(), selected?: string): string[] {
  let all: string[] = [];
  try {
    all =
      (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ??
      [];
  } catch {
    all = [];
  }
  return [...new Set([device, "UTC", ...(selected ? [selected] : []), ...all])];
}

/** 曜日の短い表記 (月曜始まり、7 個)。 */
export function weekdayLabels(locale?: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  // 2024-01-01 は月曜日。
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

/** マスク → 曜日ごとの実行フラグ (月始まり)。0 は毎日。 */
export function weekdaysToFlags(mask: number | undefined): boolean[] {
  const m = (mask ?? 0) & ALL_WEEKDAYS_MASK;
  const all = m === 0;
  return Array.from({ length: 7 }, (_, i) => all || (m & (1 << i)) !== 0);
}

/** 曜日ごとのフラグ → マスク。全曜日は 0 (毎日)、1 つも選ばないときは null (不正)。 */
export function flagsToWeekdays(flags: readonly boolean[]): number | null {
  let mask = 0;
  flags.forEach((on, i) => {
    if (on) mask |= 1 << i;
  });
  if (mask === 0) return null;
  return mask === ALL_WEEKDAYS_MASK ? 0 : mask;
}

export interface ScheduleDraft {
  kind: TaskSchedule["kind"];
  intervalMinutes: string;
  hour: string;
  minute: string;
  timezone: string;
  /** 月始まりの 7 要素。 */
  days: boolean[];
}

/**
 * 既存のスケジュール (なければ新規の既定) から編集用ドラフトを作る。新規の既定は
 * 端末のタイムゾーンの 9:00 毎日。旧データ (タイムゾーンなし) は UTC として開く。
 */
export function draftFromSchedule(schedule: TaskSchedule | undefined, device: string): ScheduleDraft {
  const base: ScheduleDraft = {
    kind: "interval",
    intervalMinutes: "60",
    hour: "9",
    minute: "0",
    timezone: device,
    days: weekdaysToFlags(0),
  };
  if (!schedule) return base;
  if (schedule.kind === "interval") return { ...base, intervalMinutes: String(schedule.minutes) };
  return {
    ...base,
    kind: "daily",
    hour: String(schedule.hour),
    minute: String(schedule.minute),
    timezone: schedule.timezone || "UTC",
    days: weekdaysToFlags(schedule.weekdays),
  };
}

/** ドラフト → 保存・プレビュー用のスケジュール。曜日が 1 つも選ばれていなければ不正。 */
export function scheduleFromDraft(d: ScheduleDraft): { ok: true; schedule: TaskSchedule } | { ok: false } {
  if (d.kind === "interval") {
    return { ok: true, schedule: { kind: "interval", minutes: Math.max(1, Number(d.intervalMinutes) || 1) } };
  }
  const weekdays = flagsToWeekdays(d.days);
  if (weekdays === null) return { ok: false };
  return {
    ok: true,
    schedule: {
      kind: "daily",
      hour: clamp(Math.floor(Number(d.hour) || 0), 0, 23),
      minute: clamp(Math.floor(Number(d.minute) || 0), 0, 59),
      timezone: d.timezone || "UTC",
      weekdays,
    },
  };
}

/** 次回実行予定の 1 行 (曜日・日付・時刻)。`timeZone` 省略時は端末のローカル。 */
export function formatRunPreview(iso: string, locale?: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
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
