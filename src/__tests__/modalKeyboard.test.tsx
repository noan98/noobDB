import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "../components/Modal";
import { isModalSubmitKey, type ModalKeyEventLike } from "../components/modalKeys";

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

function renderModal(props: { onSubmit?: () => void; submitDisabled?: boolean; onClose?: () => void }) {
  const onClose = props.onClose ?? vi.fn();
  renderWithProviders(
    <Modal onClose={onClose} onSubmit={props.onSubmit} submitDisabled={props.submitDisabled}>
      <ModalHeader onClose={onClose} closeLabel="close">
        title
      </ModalHeader>
      <ModalBody>
        <input aria-label="name" />
        <textarea aria-label="note" />
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <button type="button">ok</button>
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

  it("onSubmit を渡さないモーダル (破壊的な確認など) は何もしない", () => {
    renderModal({});
    // 例外なく素通りする (キーハンドラ自体が付かない)。
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
  });
});
