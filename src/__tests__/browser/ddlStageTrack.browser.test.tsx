import { describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { DdlStageTrack } from "../../components/DdlStageTrack";
import type { DdlStep } from "../../components/onlineDdl";

// 段階トラック (#2263): 計画 → 実行中 → 失敗の 3 状態を実ブラウザで確認する。
const step = (phase: DdlStep["phase"], subject: string, transactional = true): DdlStep => ({
  phase,
  subject,
  statements: [`-- ${phase}`],
  transactional,
  lockTimeout: transactional,
  group: 0,
});
const steps = [
  step("addNotValid", "fk_orders_user"),
  step("validate", "fk_orders_user"),
  step("createIndexConcurrently", "idx_orders_user", false),
];

const statusesOf = (root: Element) =>
  Array.from(root.querySelectorAll("[data-testid=ddl-stage]")).map((e) => e.getAttribute("data-status"));

describe("DdlStageTrack (実ブラウザ)", () => {
  it("計画: すべて未実行で、ロック強度のバッジが 3 種類出る", async () => {
    const screen = await renderInBrowser(<DdlStageTrack steps={steps} state={{ kind: "plan" }} />);
    const root = screen.getByTestId("ddl-stage-track");
    await expect.element(root).toBeVisible();
    expect(statusesOf(root.element())).toEqual(["pending", "pending", "pending"]);
    const locks = Array.from(root.element().querySelectorAll("[data-testid=ddl-stage-lock]")).map((e) =>
      e.getAttribute("data-lock"),
    );
    expect(locks).toEqual(["exclusive", "concurrent", "outsideTx"]);
    expect(root.element().querySelector("[aria-current=step]")).toBeNull();
  });

  it("実行中: 完了 / 実行中 / 未実行になり、実行中の段階が aria-current=step", async () => {
    const screen = await renderInBrowser(
      <DdlStageTrack steps={steps} state={{ kind: "running", done: 1 }} />,
    );
    const root = screen.getByTestId("ddl-stage-track").element();
    expect(statusesOf(root)).toEqual(["done", "running", "pending"]);
    expect(root.querySelector("[aria-current=step]")?.getAttribute("data-status")).toBe("running");
    const connectors = Array.from(root.querySelectorAll("[data-testid=ddl-stage-connector]")).map((e) =>
      e.getAttribute("data-filled"),
    );
    expect(connectors).toEqual(["true", "false"]);
  });

  it("失敗: 失敗した段階の後ろは未実行のまま、ここまで適用済みを示す", async () => {
    const screen = await renderInBrowser(
      <DdlStageTrack steps={steps} state={{ kind: "failed", failedIndex: 1 }} />,
    );
    const root = screen.getByTestId("ddl-stage-track").element();
    expect(statusesOf(root)).toEqual(["done", "failed", "pending"]);
    expect(root.querySelector("[aria-current=step]")?.getAttribute("data-status")).toBe("failed");
    expect(root.querySelectorAll("[data-testid=ddl-stage-applied]")).toHaveLength(1);
  });

  it("段階が 1 つ以下なら何も出さない", async () => {
    const screen = await renderInBrowser(
      <DdlStageTrack steps={steps.slice(0, 1)} state={{ kind: "plan" }} />,
    );
    expect(screen.container.querySelector("[data-testid=ddl-stage-track]")).toBeNull();
  });
});
