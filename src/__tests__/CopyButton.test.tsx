// コピー確認 UI の共通プリミティブ (#1158)。aria-label / ツールチップの切替と
// クリックの委譲を固定する (copy↔check のクロスフェード自体は motion に委ねる)。
import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { CopyButton } from "../components/CopyButton";

describe("CopyButton", () => {
  it("copied=false ではアイドル時のラベルを aria-label に持つ", () => {
    renderWithProviders(
      <CopyButton
        copied={false}
        onClick={() => {}}
        label="コピー"
        copiedLabel="コピー済み"
      />,
    );
    expect(screen.getByRole("button", { name: "コピー" })).toBeInTheDocument();
  });

  it("copied=true では確認表示のラベルへ aria-label が切り替わる", () => {
    renderWithProviders(
      <CopyButton
        copied={true}
        onClick={() => {}}
        label="コピー"
        copiedLabel="コピー済み"
      />,
    );
    expect(screen.getByRole("button", { name: "コピー済み" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "コピー" })).toBeNull();
  });

  it("クリックで onClick を呼ぶ (クリップボード書き込み自体は呼び出し側が担う)", () => {
    const onClick = vi.fn();
    renderWithProviders(
      <CopyButton copied={false} onClick={onClick} label="コピー" copiedLabel="コピー済み" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "コピー" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled のときはクリックしても onClick を呼ばない", () => {
    const onClick = vi.fn();
    renderWithProviders(
      <CopyButton
        copied={false}
        onClick={onClick}
        label="コピー"
        copiedLabel="コピー済み"
        disabled
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "コピー" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("showLabel のときはアイコンの隣に文言を表示する", () => {
    renderWithProviders(
      <CopyButton
        copied={false}
        onClick={() => {}}
        label="すべてコピー"
        copiedLabel="コピー済み"
        showLabel
      />,
    );
    expect(screen.getByText("すべてコピー")).toBeInTheDocument();
  });
});
