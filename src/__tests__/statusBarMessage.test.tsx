import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { StatusBarIcon, StatusBarText } from "../components/StatusBarMessage";

/**
 * フッターステータスバーの状態アイコン・文言 (#1213)。
 * 表示内容と、アイコン無し状態で何も描かないこと (親の `:empty` 非表示に依存) を固定する。
 */
describe("StatusBarText (#1213)", () => {
  it("メッセージを描き、内容が変わると新しい文言に差し替わる", async () => {
    const { rerender } = renderWithProviders(<StatusBarText text="実行中…" />);
    expect(screen.getByText("実行中…")).toBeInTheDocument();
    rerender(<StatusBarText text="3 行を取得しました" />);
    expect(await screen.findByText("3 行を取得しました")).toBeInTheDocument();
  });

  it("同じ messageKey のまま文言だけ変わる更新は、退場を待たずその場で書き換える", () => {
    const { rerender, container } = renderWithProviders(
      <StatusBarText text="10 行取得中…" messageKey="statusStreaming" />,
    );
    const before = screen.getByText("10 行取得中…");
    rerender(<StatusBarText text="20 行取得中…" messageKey="statusStreaming" />);
    // 同期的に新しい文言へ置き換わり、同じ要素が使い回される (exit アニメが走らない)
    expect(screen.getByText("20 行取得中…")).toBe(before);
    expect(container.textContent).not.toContain("10 行取得中…");
  });
});

describe("StatusBarIcon (#1213)", () => {
  it("kind=null では何も描かない", () => {
    const { container } = renderWithProviders(<StatusBarIcon kind={null} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("span")).toBeNull();
  });

  it.each(["running", "success", "warning"] as const)("kind=%s でアイコンを描く", (kind) => {
    const { container } = renderWithProviders(<StatusBarIcon kind={kind} />);
    expect(container.querySelector("span")).not.toBeNull();
  });

  it("running から success へ切り替わると最終的に success の要素だけが残る", async () => {
    const { container, rerender } = renderWithProviders(<StatusBarIcon kind="running" />);
    rerender(<StatusBarIcon kind="success" />);
    await screen.findByText((_, el) => el?.querySelector("svg") != null && el.tagName === "SPAN");
    expect(container.querySelectorAll("span > span").length).toBeLessThanOrEqual(2);
  });
});
