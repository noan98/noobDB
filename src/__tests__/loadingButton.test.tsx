import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, fireEvent } from "./testUtils";
import { LoadingButton } from "../components/LoadingButton";

/**
 * LoadingButton コンポーネントのユニットテスト (#538)。
 *
 * 検証ポイント:
 *   - loading=false のとき: 子テキストのみ表示、スピナーなし、disabled でない
 *   - loading=true のとき: スピナー表示、aria-busy が true、button が disabled
 *     → 二重発火の防止
 *   - disabled prop が loading と独立して機能する
 *   - onClick は loading でない通常時に呼ばれる
 *   - onClick は loading=true のとき呼ばれない (disabled により)
 */
describe("LoadingButton (#538)", () => {
  it("loading=false のとき通常のボタンとして描画される", () => {
    const { getByRole } = renderWithProviders(
      <LoadingButton>保存</LoadingButton>,
    );
    const btn = getByRole("button", { name: "保存" });
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("loading=true のとき aria-busy が true で button が disabled になる", () => {
    const { getByRole } = renderWithProviders(
      <LoadingButton loading>保存</LoadingButton>,
    );
    // aria-busy はアクセシブルな名前の計算に影響しないので role="button" でとれる
    const btn = getByRole("button");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
  });

  it("loading=true のときスピナー要素が DOM に存在する", () => {
    const { container } = renderWithProviders(
      <LoadingButton loading>処理中</LoadingButton>,
    );
    // Spinner は role="status" を持つ span として描画される
    const spinner = container.querySelector('[role="status"]');
    expect(spinner).toBeTruthy();
  });

  it("loading=false のときスピナーが表示されない", () => {
    const { container } = renderWithProviders(
      <LoadingButton>保存</LoadingButton>,
    );
    const spinner = container.querySelector('[role="status"]');
    expect(spinner).toBeNull();
  });

  it("loading=false の通常時に onClick が呼ばれる", () => {
    const handleClick = vi.fn();
    const { getByRole } = renderWithProviders(
      <LoadingButton onClick={handleClick}>実行</LoadingButton>,
    );
    fireEvent.click(getByRole("button"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("loading=true のとき disabled により onClick が発火しない (二重発火防止)", () => {
    const handleClick = vi.fn();
    const { getByRole } = renderWithProviders(
      <LoadingButton loading onClick={handleClick}>実行</LoadingButton>,
    );
    fireEvent.click(getByRole("button"));
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("disabled prop が loading と独立して button を無効化する", () => {
    const { getByRole } = renderWithProviders(
      <LoadingButton disabled>保存</LoadingButton>,
    );
    const btn = getByRole("button");
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // disabled だけなら aria-busy は付かない
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("solid variant (primary) では loading 中もボタンテキストが残る", () => {
    const { getByRole } = renderWithProviders(
      <LoadingButton variant="primary" loading>接続</LoadingButton>,
    );
    const btn = getByRole("button");
    // ボタン内のテキストノードに「接続」が含まれること
    expect(btn.textContent).toContain("接続");
  });

  it("non-solid variant (secondary) でも loading 中にテキストが残る", () => {
    const { getByRole } = renderWithProviders(
      <LoadingButton variant="secondary" loading>キャンセル</LoadingButton>,
    );
    const btn = getByRole("button");
    expect(btn.textContent).toContain("キャンセル");
  });
});
