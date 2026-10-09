// @vitest-environment jsdom (renderHook で外部ストア購読を確かめるため)
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  beginTabOpenFlight,
  endTabOpenFlight,
  resetTabOpenFlightForTest,
  TAB_OPEN_FLIGHT_MAX_MS,
  TAB_OPEN_FLIGHT_MS,
  tabOpenFlightId,
  useTabOpenFlight,
  useTabOpenFlightFor,
} from "../sharedElement";

describe("tab open flight (#1415)", () => {
  afterEach(() => {
    resetTabOpenFlightForTest();
    vi.useRealTimers();
  });

  it("ID は db / table の組で一意になり、区切り文字の衝突も起きない", () => {
    expect(tabOpenFlightId("a", "b.c")).not.toBe(tabOpenFlightId("a.b", "c"));
    expect(tabOpenFlightId("a", "b")).toBe(tabOpenFlightId("a", "b"));
  });

  it("飛行中は該当テーブルの行だけが ID を受け取り、終了後に外れる", () => {
    vi.useFakeTimers();
    const users = renderHook(() => useTabOpenFlightFor("appdb", "users"));
    const orders = renderHook(() => useTabOpenFlightFor("appdb", "orders"));
    const any = renderHook(() => useTabOpenFlight());
    expect(users.result.current).toBeNull();

    act(() => beginTabOpenFlight("appdb", "users"));
    expect(users.result.current).toBe(tabOpenFlightId("appdb", "users"));
    expect(orders.result.current).toBeNull();
    expect(any.result.current).toBe(tabOpenFlightId("appdb", "users"));

    act(() => endTabOpenFlight(tabOpenFlightId("appdb", "users")));
    expect(users.result.current).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(TAB_OPEN_FLIGHT_MS);
    });
    expect(users.result.current).toBeNull();
  });

  it("別テーブルの飛行を始めたあと、古い飛行の end は作用しない", () => {
    const h = renderHook(() => useTabOpenFlight());
    act(() => beginTabOpenFlight("appdb", "users"));
    act(() => beginTabOpenFlight("appdb", "orders"));
    act(() => endTabOpenFlight(tabOpenFlightId("appdb", "users"), true));
    expect(h.result.current).toBe(tabOpenFlightId("appdb", "orders"));
  });

  it("end が呼ばれなくても保険のタイマーで外れる", () => {
    vi.useFakeTimers();
    const h = renderHook(() => useTabOpenFlight());
    act(() => beginTabOpenFlight("appdb", "users"));
    act(() => {
      vi.advanceTimersByTime(TAB_OPEN_FLIGHT_MAX_MS);
    });
    expect(h.result.current).toBeNull();
  });

  it("force で即時に解除できる", () => {
    const h = renderHook(() => useTabOpenFlight());
    act(() => beginTabOpenFlight("appdb", "users"));
    act(() => endTabOpenFlight(tabOpenFlightId("appdb", "users"), true));
    expect(h.result.current).toBeNull();
  });
});
