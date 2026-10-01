import { describe, expect, it, vi } from "vitest";
import { renderInBrowser } from "./render";
import { t } from "../../i18n";
import { TaskManager } from "../../components/TaskManager";
import { makeProfile } from "../fixtures/componentFixtures";

// #1272 — タスクスケジューラの閉じる (×) ボタンのツールチップが、直下の
// 「新規タスク」ボタンに重ならないこと、および空状態から直接作成できることを
// 実ブラウザの実レイアウトで固定する。
vi.mock("../../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listTasks: vi.fn(async () => []),
      getSchedulerSettings: vi.fn(async () => ({ catch_up_missed: false })),
    },
    listenTaskRunEvents: vi.fn(async () => () => {}),
  };
});

const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("タスクスケジューラ (実ブラウザ)", () => {
  it("閉じるボタンのツールチップが「新規タスク」ボタンに重ならない", async () => {
    const screen = await renderInBrowser(
      <TaskManager profiles={[makeProfile()]} onClose={() => {}} />,
    );
    const close = screen.getByRole("button", { name: t("taskManagerClose") });
    await expect.element(close).toBeVisible();
    await close.hover();

    await expect
      .poll(() => document.querySelector('[role="tooltip"]') !== null, { timeout: 3_000 })
      .toBe(true);
    const tooltip = document.querySelector('[role="tooltip"]') as HTMLElement;
    const tipRect = tooltip.getBoundingClientRect();

    const newButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes(t("taskCreate")),
    );
    expect(newButtons.length).toBeGreaterThan(0);
    for (const b of newButtons) {
      expect(intersects(tipRect, b.getBoundingClientRect())).toBe(false);
    }
  });
});
