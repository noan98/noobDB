import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderInBrowser } from "./render";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "../../components/Modal";
import { Button } from "../../components/ui";

// 内容の増減で見出しと主ボタンが上下へジャンプしない (上寄せアンカー配置、#2123)。
function Harness({ placement }: { placement?: "top" | "center" }) {
  const [extra, setExtra] = useState(false);
  return (
    <Modal onClose={() => {}} placement={placement} width="480px">
      <ModalHeader onClose={() => {}} closeLabel="close">
        <span data-testid="heading">Title</span>
      </ModalHeader>
      <ModalBody>
        <button type="button" onClick={() => setExtra((v) => !v)}>
          grow
        </button>
        {extra && <div style={{ height: 240 }}>more</div>}
      </ModalBody>
      <ModalFooter>
        <Button type="button">ok</Button>
      </ModalFooter>
    </Modal>
  );
}

const top = (el: Element) => el.getBoundingClientRect().top;

describe("Modal の配置 (実ブラウザ)", () => {
  it("既定 (top) は内容が増えても見出しの位置が変わらない", async () => {
    const screen = await renderInBrowser(<Harness />);
    const heading = screen.getByTestId("heading");
    await expect.element(heading).toBeVisible();
    await new Promise((r) => setTimeout(r, 400));
    const before = top(heading.element());
    await screen.getByRole("button", { name: "grow" }).click();
    await expect.element(screen.getByText("more")).toBeVisible();
    expect(top(heading.element())).toBe(before);
  });

  it("center は内容が増えると見出しが上へ動く", async () => {
    const screen = await renderInBrowser(<Harness placement="center" />);
    const heading = screen.getByTestId("heading");
    await expect.element(heading).toBeVisible();
    await new Promise((r) => setTimeout(r, 400));
    const before = top(heading.element());
    await screen.getByRole("button", { name: "grow" }).click();
    await expect.element(screen.getByText("more")).toBeVisible();
    expect(top(heading.element())).toBeLessThan(before);
  });
});
