// ダンプ画面の生成エンジンのカード選択 (#2094)。実 Chromium で、カードの切り替えと
// 「エンジンのせいで効かないオプションが理由つきで無効になる」ことを固定する。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "vitest-browser-react";
import { renderInBrowser } from "./render";
import { installTauriMock, onCommand } from "./tauriMock";
import { DumpModal } from "../../components/DumpModal";
import { t } from "../../i18n";

afterEach(async () => {
  await cleanup();
});

function mockTool(path: string | null) {
  installTauriMock();
  onCommand("dump_tool_status", () => ({ tool: "mysqldump", path, install: null }));
}

describe("ダンプの生成エンジン (実ブラウザ)", () => {
  beforeEach(() => mockTool("/usr/bin/mysqldump"));

  it("内蔵カードに切り替えると、単一トランザクションが理由つきで無効になる", async () => {
    const screen = await renderInBrowser(
      <DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />,
    );
    const native = screen.getByTestId("dump-engine-native");
    const external = screen.getByTestId("dump-engine-external");
    await expect.element(external).toHaveAttribute("aria-pressed", "true");
    await expect.element(screen.getByRole("switch", { name: t("dumpOptSingleTransaction") })).toBeEnabled();

    await native.click();
    await expect.element(native).toHaveAttribute("aria-pressed", "true");
    await expect.element(external).toHaveAttribute("aria-pressed", "false");
    await expect.element(screen.getByRole("switch", { name: t("dumpOptSingleTransaction") })).toBeDisabled();
    await expect.element(screen.getByText(t("dumpLockNativeConsistency"))).toBeVisible();
    // エンジンカードはモーダル上部 (オプションより上) にある。
    const nativeTop = ((await native.element()) as HTMLElement).getBoundingClientRect().top;
    const optionTop = (
      (await screen.getByTestId("dump-group-data").element()) as HTMLElement
    ).getBoundingClientRect().top;
    expect(nativeTop).toBeLessThan(optionTop);
  });
});

describe("ダンプの生成エンジン: ツール未導入 (実ブラウザ)", () => {
  beforeEach(() => mockTool(null));

  it("外部ツールのカードが無効になり、理由が画面に出る", async () => {
    const screen = await renderInBrowser(
      <DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />,
    );
    const external = screen.getByTestId("dump-engine-external");
    await expect.element(external).toBeDisabled();
    await expect
      .element(screen.getByText(t("dumpEngineExternalDisabled", { tool: "mysqldump" })))
      .toBeVisible();
    await expect.element(screen.getByTestId("dump-engine-native")).toBeEnabled();
  });
});
