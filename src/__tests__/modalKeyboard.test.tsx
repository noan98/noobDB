import { createPortal } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "../components/Modal";
import {
  isImeComposing,
  isModalSubmitKey,
  isPlainEnterKey,
  type ModalKeyEventLike,
} from "../components/modalKeys";
import { RenameTableDialog } from "../components/RenameTableDialog";
import { ListboxSelect } from "../components/ListboxSelect";

/**
 * モーダル / フォームのキーボード操作の統一 (#1114)。
 *
 * - Cmd/Ctrl+Enter で主アクション (どのフィールドにフォーカスがあっても)
 * - Esc で閉じる (Chakra Dialog)
 * - 主アクションが無効なときはキーボードからも実行しない
 */

const key = (over: Partial<ModalKeyEventLike> = {}): ModalKeyEventLike => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("isModalSubmitKey", () => {
  it("Ctrl+Enter / Cmd+Enter で実行する", () => {
    expect(isModalSubmitKey(key())).toBe(true);
    expect(isModalSubmitKey(key({ ctrlKey: false, metaKey: true }))).toBe(true);
  });

  it("素の Enter は実行しない (複数行入力の改行・単一入力欄は各モーダルの既存挙動)", () => {
    expect(isModalSubmitKey(key({ ctrlKey: false }))).toBe(false);
  });

  it("Shift / Alt 付きは別のショートカットとして扱う", () => {
    expect(isModalSubmitKey(key({ shiftKey: true }))).toBe(false);
    expect(isModalSubmitKey(key({ altKey: true }))).toBe(false);
  });

  it("IME 変換中・処理済み・リピートでは実行しない", () => {
    expect(isModalSubmitKey(key({ isComposing: true }))).toBe(false);
    expect(isModalSubmitKey(key({ defaultPrevented: true }))).toBe(false);
    expect(isModalSubmitKey(key({ repeat: true }))).toBe(false);
  });

  it("Enter 以外は対象外", () => {
    expect(isModalSubmitKey(key({ key: "s" }))).toBe(false);
  });
});

function renderModal(props: {
  onSubmit?: () => void;
  submitDisabled?: boolean;
  submitBusy?: boolean;
  onClose?: () => void;
}) {
  const onClose = props.onClose ?? vi.fn();
  renderWithProviders(
    <Modal
      onClose={onClose}
      onSubmit={props.onSubmit}
      submitDisabled={props.submitDisabled}
      submitBusy={props.submitBusy}
    >
      <ModalHeader onClose={onClose} closeLabel="close">
        title
      </ModalHeader>
      <ModalBody>
        <input aria-label="name" />
        <textarea aria-label="note" />
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <button type="button">cancel</button>
        <button type="button" disabled={props.submitDisabled}>
          ok
        </button>
      </ModalFooter>
    </Modal>,
  );
}

describe("Modal の Cmd/Ctrl+Enter", () => {
  it("どのフィールドからでも主アクションを実行する", () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("note"), { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("素の Enter では実行しない", () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });
    fireEvent.keyDown(screen.getByLabelText("note"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("主アクションが無効ならキーボードからも実行しない", () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit, submitDisabled: true });
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("無効時の Cmd/Ctrl+Enter は拒否の印 (data-submit-rejected) を一度だけ付け、animationend で外す (#1831)", () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit, submitDisabled: true });
    const content = screen.getByRole("dialog");
    expect(content).not.toHaveAttribute("data-submit-rejected");
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
    expect(content).toHaveAttribute("data-submit-rejected");
    fireEvent.animationEnd(content);
    expect(content).not.toHaveAttribute("data-submit-rejected");
  });

  it("無効時の Cmd/Ctrl+Enter は defaultPrevented になる", () => {
    renderModal({ onSubmit: vi.fn(), submitDisabled: true });
    const notPrevented = fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
    expect(notPrevented).toBe(false);
  });

  it("処理中 (submitBusy) は揺らさない", () => {
    renderModal({ onSubmit: vi.fn(), submitDisabled: true, submitBusy: true });
    const content = screen.getByRole("dialog");
    const notPrevented = fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
    expect(notPrevented).toBe(false);
    fireEvent.pointerDown(screen.getByRole("button", { name: "ok" }));
    expect(content).not.toHaveAttribute("data-submit-rejected");
  });

  it("無効な主ボタン (フッター最後) の pointerdown で揺れ、キャンセルでは揺れない", () => {
    renderModal({ onSubmit: vi.fn(), submitDisabled: true });
    const content = screen.getByRole("dialog");
    fireEvent.pointerDown(screen.getByRole("button", { name: "cancel" }));
    expect(content).not.toHaveAttribute("data-submit-rejected");
    fireEvent.pointerDown(screen.getByRole("button", { name: "ok" }));
    expect(content).toHaveAttribute("data-submit-rejected");
  });

  it("ラッパー (span) 入りでも主ボタンだけが揺れ、補助の無効ボタンは揺れない", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <Modal onClose={onClose} onSubmit={vi.fn()} submitDisabled>
        <ModalBody>body</ModalBody>
        <ModalFooter>
          <span>
            <button type="button" disabled>
              aux
            </button>
          </span>
          <span>
            <button type="button" disabled>
              ok
            </button>
          </span>
        </ModalFooter>
      </Modal>,
    );
    const content = screen.getByRole("dialog");
    fireEvent.pointerDown(screen.getByRole("button", { name: "aux" }));
    expect(content).not.toHaveAttribute("data-submit-rejected");
    fireEvent.pointerDown(screen.getByRole("button", { name: "ok" }));
    expect(content).toHaveAttribute("data-submit-rejected");
  });

  it("破壊的な並び (無効な実行 → 有効なキャンセル) では実行ボタンで揺れない", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <Modal onClose={onClose} onSubmit={vi.fn()} submitDisabled>
        <ModalBody>body</ModalBody>
        <ModalFooter>
          <button type="button" disabled>
            danger
          </button>
          <div style={{ flex: 1 }} />
          <button type="button">cancel</button>
        </ModalFooter>
      </Modal>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "danger" }));
    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-submit-rejected");
  });

  it("有効時・素の Enter では拒否の印を付けない", () => {
    renderModal({ onSubmit: vi.fn() });
    const content = screen.getByRole("dialog");
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter" });
    expect(content).not.toHaveAttribute("data-submit-rejected");
  });

  it("reduced-motion (data-motion=reduced) では拒否の印を付けない (#1831)", () => {
    document.documentElement.setAttribute("data-motion", "reduced");
    try {
      renderModal({ onSubmit: vi.fn(), submitDisabled: true });
      fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
      expect(screen.getByRole("dialog")).not.toHaveAttribute("data-submit-rejected");
    } finally {
      document.documentElement.removeAttribute("data-motion");
    }
  });

  it("onSubmit を渡さないモーダル (破壊的な確認など) は何もしない", () => {
    renderModal({});
    // 例外なく素通りする (キーハンドラ自体が付かない)。
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
  });
});

describe("IME 変換確定の Enter (#1515)", () => {
  const ev = (key: string, nativeEvent: { isComposing?: boolean; keyCode?: number }) => ({
    key,
    nativeEvent,
  });

  it("isComposing / keyCode 229 を変換中と判定する", () => {
    expect(isImeComposing(ev("Enter", { isComposing: true }))).toBe(true);
    expect(isImeComposing(ev("Enter", { isComposing: false, keyCode: 229 }))).toBe(true);
    expect(isImeComposing(ev("Enter", { isComposing: false, keyCode: 13 }))).toBe(false);
  });

  it("isPlainEnterKey は変換中の Enter と Enter 以外を除く", () => {
    expect(isPlainEnterKey(ev("Enter", { isComposing: false }))).toBe(true);
    expect(isPlainEnterKey(ev("Enter", { isComposing: true }))).toBe(false);
    expect(isPlainEnterKey(ev("Enter", { keyCode: 229 }))).toBe(false);
    expect(isPlainEnterKey(ev("a", {}))).toBe(false);
  });

  it("RenameTableDialog は変換確定の Enter で確定せず、通常の Enter で確定する", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <RenameTableDialog
        driver="mysql"
        table="users"
        existingTables={[]}
        buildSql={(n) => `ALTER TABLE users RENAME TO ${n};`}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "ゆーざー" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("ゆーざー");
  });

  it("RenameTableDialog で Ctrl+Enter を押しても onConfirm は 1 回だけ", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <RenameTableDialog
        driver="mysql"
        table="users"
        existingTables={[]}
        buildSql={(n) => `ALTER TABLE users RENAME TO ${n};`}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "people" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("isPlainEnterKey は修飾キー付き Enter を除く", () => {
    const base = { key: "Enter", nativeEvent: {} };
    expect(isPlainEnterKey({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainEnterKey({ ...base, metaKey: true })).toBe(false);
    expect(isPlainEnterKey({ ...base, shiftKey: true })).toBe(false);
    expect(isPlainEnterKey({ ...base, altKey: true })).toBe(false);
  });

  it("ポータル描画の子 (確認ダイアログ等) の Ctrl+Enter では外側の onSubmit を再発火しない (#1604)", () => {
    const onSubmit = vi.fn();
    renderWithProviders(
      <Modal onSubmit={onSubmit} onClose={() => {}}>
        <ModalBody>
          <input aria-label="inside" />
          {createPortal(<input aria-label="portaled" />, document.body)}
        </ModalBody>
      </Modal>,
    );
    fireEvent.keyDown(screen.getByLabelText("portaled"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("inside"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("モーダル内の ListboxSelect と Esc (#1950)", () => {
  function Harness({ onClose }: { onClose: () => void }) {
    return (
      <Modal onClose={onClose} onSubmit={vi.fn()}>
        <ModalBody>
          <ListboxSelect
            ariaLabel="形式"
            value="a"
            options={[{ value: "a" }, { value: "b" }]}
            onChange={() => {}}
          />
        </ModalBody>
      </Modal>
    );
  }

  it("開いたまま Esc を押すと listbox だけ閉じ、モーダルは閉じない", async () => {
    const onClose = vi.fn();
    renderWithProviders(<Harness onClose={onClose} />);
    const trigger = await screen.findByLabelText("形式");
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // 閉じた後の Esc は従来どおりモーダルを閉じる。
    fireEvent.keyDown(trigger, { key: "Escape" });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
