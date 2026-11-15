/**
 * 裏のタブでクエリが終わったときの「未確認の結果」印 (#2353) の判定ロジック (純関数)。
 *
 * 非アクティブなタブ (どのペインの表示中タブでもないタブ) で実行が終わったときだけ印を立て、
 * そのタブが表示されたら (または再実行を始めたら) 消す。副作用は持たず、App.tsx と
 * TabBar.tsx がここを経由して判定・表示を揃える。
 */
import type { QueryNotificationKind } from "./queryNotify";
import type { SemanticRole } from "./semanticColors";

/** タブに残す未確認の結果。タイムアウトは失敗として扱う。 */
export type UnseenOutcome = "done" | "error" | "cancelled";

/** 通知用の完了種別をタブの印へ写す (タイムアウトは error)。 */
export function outcomeFromKind(kind: QueryNotificationKind): UnseenOutcome {
  switch (kind) {
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return "error";
  }
}

export interface UnseenOutcomeInput {
  /** 終わった実行のタブ ID。 */
  tabId: string;
  /** いずれかのペインで表示中 (アクティブ) のタブ ID 一覧。 */
  visibleTabIds: readonly string[];
  /** 自動リフレッシュの tick か (毎周期で印を付けるとノイズなので対象外)。 */
  autoRefresh?: boolean;
  /** 接続断など、結果として扱わない終わり方か。 */
  connectionLost?: boolean;
}

/** 実行終了時に印を立てるべきか。見えているタブ・自動リフレッシュ・接続断では立てない。 */
export function shouldMarkUnseenOutcome(input: UnseenOutcomeInput): boolean {
  if (input.autoRefresh || input.connectionLost) return false;
  return !input.visibleTabIds.includes(input.tabId);
}

/** 表示中になったタブの印を消す。変更が無ければ同じ配列参照を返す。 */
export function clearSeenOutcomes<T extends { id: string; unseenOutcome?: UnseenOutcome }>(
  tabs: T[],
  visibleTabIds: readonly string[],
): T[] {
  const stale = (tt: T) => tt.unseenOutcome !== undefined && visibleTabIds.includes(tt.id);
  if (!tabs.some(stale)) return tabs;
  return tabs.map((tt) => (stale(tt) ? { ...tt, unseenOutcome: undefined } : tt));
}

/** 印の見た目。色 (意味役割) に加えて形 (glyph) でも区別する。cancelled は役割を持たず muted。 */
export const OUTCOME_MARK: Record<
  UnseenOutcome,
  { role: SemanticRole | null; glyph: string; labelKey: OutcomeLabelKey }
> = {
  done: { role: "success", glyph: "●", labelKey: "tabOutcomeDone" },
  error: { role: "danger", glyph: "!", labelKey: "tabOutcomeError" },
  cancelled: { role: null, glyph: "○", labelKey: "tabOutcomeCancelled" },
};

export type OutcomeLabelKey = "tabOutcomeDone" | "tabOutcomeError" | "tabOutcomeCancelled";
