import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "./testUtils";
import { t } from "../i18n";

/**
 * 設定モーダル (#604)。マウント時に `api.readLogs()` (ログビューア) と
 * `getCurrentAppVersion()` (更新セクション) を呼ぶため、両方をモックして実 Tauri
 * ランタイムなしでレンダリングできるようにする。ダイアログとしてマウントでき、
 * タイトルが可視であること・閉じるボタンで `onClose` が呼ばれることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      readLogs: vi.fn().mockResolvedValue({ text: "", path: "/tmp/noobdb.log" }),
    },
  };
});

vi.mock("../updater", () => ({
  getCurrentAppVersion: vi.fn().mockResolvedValue("1.2.3"),
  checkForAppUpdate: vi.fn().mockResolvedValue(null),
}));

// SettingsView から import される updatePrompt はダイアログ経由でのみ使われるため
// 空のスタブで十分 (マウント時には呼ばれない)。
vi.mock("../components/updatePrompt", () => ({
  confirmAndInstallUpdate: vi.fn(),
}));

import { SettingsView } from "../components/SettingsView";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsView render smoke (#604)", () => {
  it("mounts as a dialog and shows the settings title", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(t("settingsTitle"))).toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", async () => {
    const onClose = vi.fn();
    renderWithProviders(<SettingsView theme="dark" onClose={onClose} />);
    // 閉じるボタンは `ModalHeader` でタイトル (見出し) と並んでいるので、見出しの親
    // (= ヘッダ) に絞って探す。設定画面には 140 個を超えるボタンがあり、画面全体へ
    // `getByRole("button", { name })` を投げると jsdom ではボタンごとに祖先の
    // getComputedStyle を辿る可視性判定が走って 1 回で約 0.8 秒かかる。負荷のある CI
    // ではそれだけでテストの制限時間 (5 秒) を使い切っていた。
    const heading = await screen.findByRole("heading", { name: t("settingsTitle") });
    const header = heading.parentElement;
    if (!header) throw new Error("settings modal header not found");
    fireEvent.click(within(header).getByRole("button", { name: t("settingsClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // 密度・モーション設定は #975 で共有プリミティブ `Segmented` へ移行した。旧実装は
  // `role="group"` + `aria-pressed` のトグルボタン列だったが、`ResultViewSwitch` と
  // 同じ `role="radiogroup"` + `role="radio"` (`aria-checked`) の排他選択になった
  // ことを固定する。
  it("renders the density and motion-preference settings as sliding-pill radiogroups", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(t("settingsTitle"))).toBeInTheDocument(),
    );

    const density = screen.getByRole("radiogroup", { name: t("settingsDensity") });
    expect(density).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: t("settingsDensityNormal") }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");

    const motion = screen.getByRole("radiogroup", { name: t("settingsMotionPreference") });
    expect(motion).toBeInTheDocument();
    expect(
      screen
        .getByRole("radio", { name: t("settingsMotionPreferenceSystem") })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });
});

// 項目の説明文は常時表示せず、ラベル横のインフォメーションアイコンに畳んである。
// 本文はフォーカス (クリック含む) で吹き出しに出て、`aria-describedby` でボタンに
// 結び付くこと、結果グリッドのモードの説明が見出しと項目で二重に出ないことを固定する。
describe("SettingsView info icons", () => {
  it("hides item descriptions behind an info icon that reveals them on focus", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    await screen.findByRole("heading", { name: t("settingsTitle") });

    expect(screen.queryByText(t("settingsFlightRecorderHelp"))).toBeNull();
    expect(screen.queryByText(t("settingsResultGridModeHelp"))).toBeNull();

    const label = screen.getByText(t("settingsFlightRecorder"), { selector: "h3" });
    const wrapper = label.parentElement;
    if (!wrapper) throw new Error("info wrapper not found");
    const info = within(wrapper).getByRole("button", { name: t("settingsInfoAria") });
    fireEvent.focus(info);

    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(t("settingsFlightRecorderHelp"));
    expect(info.getAttribute("aria-describedby")).toBe(tip.id);
  });
});
