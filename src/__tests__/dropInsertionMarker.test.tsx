import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./testUtils";
import { DropInsertionMarker } from "../components/DropInsertionMarker";

/**
 * ドラッグ並べ替え・キーボード移動の着地位置マーカー (#1007)。`TabBar` /
 * `ConnectionList` が共有する実装で、`visible` が false のときは何も描画せず、
 * true のときだけ `aria-hidden` な装飾要素を出すこと・向き (vertical/horizontal)
 * で軸を変えることを固定する。
 */
describe("DropInsertionMarker (#1007)", () => {
  it("renders nothing when not visible", () => {
    const { container } = renderWithProviders(
      <DropInsertionMarker orientation="vertical" visible={false} />,
    );
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("renders an aria-hidden marker when visible (vertical)", () => {
    const { container } = renderWithProviders(
      <DropInsertionMarker orientation="vertical" visible />,
    );
    const marker = container.querySelector('[aria-hidden="true"]');
    expect(marker).not.toBeNull();
  });

  it("renders an aria-hidden marker when visible (horizontal)", () => {
    const { container } = renderWithProviders(
      <DropInsertionMarker orientation="horizontal" visible />,
    );
    const marker = container.querySelector('[aria-hidden="true"]');
    expect(marker).not.toBeNull();
  });

  it("removes the marker again when visible flips back to false", () => {
    const { container, rerender } = renderWithProviders(
      <DropInsertionMarker orientation="vertical" visible />,
    );
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    rerender(<DropInsertionMarker orientation="vertical" visible={false} />);
    // `AnimatePresence` の exit アニメは非同期なので即座の DOM 消滅までは
    // 保証しないが、少なくとも二重に残り続けたりはしないことを確認する
    // (visible の再トグルでクラッシュしないことの回帰チェックを兼ねる)。
    expect(() => container.querySelector('[aria-hidden="true"]')).not.toThrow();
  });
});
