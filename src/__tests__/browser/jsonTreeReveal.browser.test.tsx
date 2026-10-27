import { beforeEach, describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { JsonTreeView } from "../../components/JsonTreeView";
import { parseJsonLossless } from "../../components/jsonTree";
import { t } from "../../i18n";

// JSON ツリーの展開リビール (#1863) を実ブラウザで検証する。
// 展開 / 一括展開で新しく現れた行にだけ opacity/transform の Animation が付き、
// 件数は可視範囲以内、畳む操作・reduced-motion・ハイコントラストでは付かないことを確かめる。

const doc = JSON.stringify({
  users: Array.from({ length: 30 }, (_, i) => ({ id: i, name: `u${i}`, tags: ["a", "b"] })),
  meta: { a: 1, b: { c: 2 } },
});
const root = parseJsonLossless(doc);
if (!root) throw new Error("parse failed");

const items = () => Array.from(document.querySelectorAll<HTMLElement>("[role='treeitem']"));
const animated = () => items().filter((el) => el.getAnimations().length > 0);
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const click = (label: string) =>
  (
    Array.from(document.querySelectorAll("button")).find((b) => b.textContent === label) as HTMLElement
  ).click();

function Host({ reduced }: { reduced: "never" | "always" }) {
  return (
    <MotionConfig reducedMotion={reduced}>
      <div style={{ width: 640 }}>
        <JsonTreeView root={root as NonNullable<typeof root>} />
      </div>
    </MotionConfig>
  );
}

describe("JSON ツリーの展開リビール (#1863, 実ブラウザ)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("一括展開で新規行だけが再生され、既存行・畳む操作では再生しない", async () => {
    await renderInBrowser(<Host reduced="never" />);
    const initial = items();
    expect(animated().length).toBe(0);
    click(t("jsonTreeExpandAll"));
    await expect.poll(() => animated().length).toBeGreaterThan(0);
    // 既存の行 (ルート) には付かない。
    expect(initial.some((el) => el.getAnimations().length > 0)).toBe(false);
    // 可視範囲に限定される (スクロール領域は maxH 50vh)。
    expect(animated().length).toBeLessThan(items().length);
    for (const el of animated()) for (const a of el.getAnimations()) a.finish();
    click(t("jsonTreeCollapseAll"));
    await settle();
    expect(animated().length).toBe(0);
  });

  it("1 ノードのクリック展開でも子行が再生される", async () => {
    await renderInBrowser(<Host reduced="never" />);
    const usersRow = items().find((el) => el.textContent?.includes("users"));
    if (!usersRow) throw new Error("users row not found");
    usersRow.click();
    await expect.poll(() => animated().length).toBeGreaterThan(0);
    expect(animated().includes(usersRow)).toBe(false);
  });

  it("reduced-motion では再生しない", async () => {
    await renderInBrowser(<Host reduced="always" />);
    click(t("jsonTreeExpandAll"));
    await expect.poll(() => items().length).toBeGreaterThan(5);
    await settle();
    expect(animated().length).toBe(0);
  });

  it("ハイコントラストでは再生しない", async () => {
    document.documentElement.setAttribute("data-theme", "hc-dark");
    await renderInBrowser(<Host reduced="never" />);
    click(t("jsonTreeExpandAll"));
    await expect.poll(() => items().length).toBeGreaterThan(5);
    await settle();
    expect(animated().length).toBe(0);
  });
});
