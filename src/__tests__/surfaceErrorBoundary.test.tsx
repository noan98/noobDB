import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { WorkspaceSurface } from "../components/WorkspaceSurface";

/**
 * 全画面サーフェスの描画例外 (ER 図で画面が真っ黒になる不具合)。ErrorBoundary が無いと
 * React はルートごとアンマウントし、背景だけが残る。サーフェス単位で受け止め、
 * エラー内容と「再試行 / 閉じる」を出すことを固定する。
 */

let shouldThrow = true;
function Boom() {
  if (shouldThrow) throw new Error("boom: layout failed");
  return <p>recovered</p>;
}

function Harness({ onClose }: { onClose: () => void }) {
  const [sibling] = useState("sidebar-alive");
  return (
    <>
      <p>{sibling}</p>
      <WorkspaceSurface view="erd" onClose={onClose}>
        <Boom />
      </WorkspaceSurface>
    </>
  );
}

describe("SurfaceErrorBoundary (WorkspaceSurface)", () => {
  afterEach(() => {
    shouldThrow = true;
    vi.restoreAllMocks();
  });

  it("中身が描画中に例外を投げても、ほかの UI は残りエラーと閉じる導線が出る", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<Harness onClose={onClose} />);

    expect(screen.getByText("sidebar-alive")).toBeInTheDocument();
    expect(screen.getByText(t("surfaceErrorTitle"))).toBeInTheDocument();
    expect(screen.getByText("boom: layout failed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: t("surfaceErrorClose") }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("再試行で中身を描き直す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    renderWithProviders(<Harness onClose={() => {}} />);
    expect(screen.getByText(t("surfaceErrorTitle"))).toBeInTheDocument();

    shouldThrow = false;
    await user.click(screen.getByRole("button", { name: t("surfaceErrorRetry") }));
    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
