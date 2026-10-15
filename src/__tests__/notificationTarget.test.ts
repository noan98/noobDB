import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_FOCUS_WINDOW_MS,
  consumeFocusTarget,
  tabIdFromNotificationExtra,
} from "../notificationTarget";

describe("tabIdFromNotificationExtra", () => {
  it("文字列の tabId だけ取り出す", () => {
    expect(tabIdFromNotificationExtra({ tabId: "t1" })).toBe("t1");
    expect(tabIdFromNotificationExtra({ tabId: "" })).toBeNull();
    expect(tabIdFromNotificationExtra({ tabId: 3 })).toBeNull();
    expect(tabIdFromNotificationExtra(null)).toBeNull();
    expect(tabIdFromNotificationExtra("x")).toBeNull();
  });
});

describe("consumeFocusTarget", () => {
  it("猶予内ならタブを返して記録を消す", () => {
    expect(consumeFocusTarget({ tabId: "t1", at: 1000 }, 1000 + 5000)).toEqual({ tabId: "t1", next: null });
  });
  it("猶予を過ぎたら移動せず記録も捨てる", () => {
    expect(consumeFocusTarget({ tabId: "t1", at: 0 }, NOTIFICATION_FOCUS_WINDOW_MS + 1)).toEqual({
      tabId: null,
      next: null,
    });
  });
  it("記録が無い・時刻が巻き戻っているときは移動しない", () => {
    expect(consumeFocusTarget(null, 100)).toEqual({ tabId: null, next: null });
    expect(consumeFocusTarget({ tabId: "t", at: 500 }, 100).tabId).toBeNull();
  });
});
