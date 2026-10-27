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
      getHistoryRetentionDays: vi.fn().mockResolvedValue(0),
      setHistoryRetentionDays: vi.fn().mockResolvedValue(0),
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
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsView render smoke (#604)", { timeout: 15_000 }, () => {
  it("mounts as a dialog and shows the settings title", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(t("settingsTitle"))).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("診断の入口 (#1622): 診断情報の書き出しと、パフォーマンス計測のスイッチが出る", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    // role / label の検索は設定画面の要素数だと遅いので、文言と id で確認する。
    expect(await screen.findByText(t("settingsDiagBundle"))).toBeInTheDocument();
    expect(screen.getByText(t("settingsPerfMeasure"))).toBeInTheDocument();
    expect(document.getElementById("settings-perf-measure")).not.toBeNull();
  });

  it("initialSection を渡すと該当セクションのナビが選択状態になる (#1475)", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} initialSection="settings-sec-ai" />);
    const nav = await screen.findByRole("navigation", { name: t("settingsTitle") });
    await waitFor(() =>
      expect(
        within(nav).getByText(t("aiSettingsTitle")).closest("button")?.getAttribute("aria-current"),
      ).toBe("true"),
    );
  });

  it("左ナビのアクティブ項目だけに滑るハイライトが載り、各項目に先頭グリフがある (#1876)", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} initialSection="settings-sec-ai" />);
    const nav = await screen.findByRole("navigation", { name: t("settingsTitle") });
    await waitFor(() => expect(within(nav).getAllByTestId("active-row-highlight")).toHaveLength(1));
    const active = within(nav).getByText(t("aiSettingsTitle")).closest("button");
    expect(active?.querySelector("[data-testid=active-row-highlight]")).not.toBeNull();
    for (const b of within(nav).getAllByRole("button")) expect(b.querySelector("svg")).not.toBeNull();
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
    await waitFor(() => expect(screen.getByText(t("settingsTitle"))).toBeInTheDocument());

    const density = screen.getByRole("radiogroup", { name: t("settingsDensity") });
    expect(density).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: t("settingsDensityNormal") }).getAttribute("aria-checked")).toBe(
      "true",
    );

    const motion = screen.getByRole("radiogroup", { name: t("settingsMotionPreference") });
    expect(motion).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: t("settingsMotionPreferenceSystem") }).getAttribute("aria-checked"),
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

describe("SettingsView の数値欄 (#1534)", () => {
  it("上限を超えた値を入力して blur すると、clamp 後の値が欄に戻る", async () => {
    renderWithProviders(<SettingsView theme="light" onClose={() => {}} />);
    // 設定モーダルは DOM が大きく、ラベル検索 (findByLabelText) だけで既定の 5 秒を
    // 使い切ることがあるため、見出しの描画を待ってから id で直接引く。
    await screen.findByRole("heading", { name: t("settingsTitle") });
    const input = document.getElementById("settings-font-size") as HTMLInputElement;
    expect(input).not.toBeNull();
    // 上限 (24) にしてから、さらに大きい値を入れる。
    fireEvent.change(input, { target: { value: "24" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe("24"));
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe("24"));
  });
});

describe("クエリ履歴の保持期間 (#1539)", () => {
  // フライトレコーダにも同名ラベル「保持期間 (日数)」があるので id で引く。
  const historyInput = async () => {
    await waitFor(() => expect(document.getElementById("settings-history-retention")).not.toBeNull());
    return document.getElementById("settings-history-retention") as HTMLInputElement;
  };

  // SettingsView の描画は重いので 1 回だけ描画し、読み込み・保存・範囲外の巻き戻しを順に確かめる。
  it("保存済みの値を読み込み、確定で保存し、範囲外の入力は保存せず元の値へ戻す", async () => {
    vi.mocked(api.getHistoryRetentionDays).mockResolvedValue(14);
    renderWithProviders(<SettingsView theme="dark" onClose={() => {}} />);
    const input = await historyInput();
    await waitFor(() => expect(input.value).toBe("14"));
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);
    await waitFor(() => expect(api.setHistoryRetentionDays).toHaveBeenCalledWith(30));
    vi.mocked(api.setHistoryRetentionDays).mockClear();
    fireEvent.change(input, { target: { value: "99999" } });
    fireEvent.blur(input);
    expect(api.setHistoryRetentionDays).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe("30"));
  });
});

describe("設定画面の不整合 (#1604)", () => {
  it("スキーマドリフトのセクションがナビに出る", async () => {
    renderWithProviders(<SettingsView theme="dark" onClose={() => {}} />);
    const nav = await screen.findByRole("navigation", { name: t("settingsTitle") });
    expect(within(nav).getByText(t("settingsSchemaDrift"))).toBeInTheDocument();
  });

  it("履歴保持日数の取得に失敗したら欄を無効のままにする (0 と誤表示して編集させない)", async () => {
    vi.mocked(api.getHistoryRetentionDays).mockRejectedValueOnce(new Error("boom"));
    renderWithProviders(<SettingsView theme="dark" onClose={() => {}} />);
    await waitFor(() => expect(document.getElementById("settings-history-retention")).not.toBeNull());
    const input = document.getElementById("settings-history-retention") as HTMLInputElement;
    await waitFor(() =>
      expect(
        screen.getByText(t("settingsHistoryRetentionLoadFailed", { error: "Error: boom" })),
      ).toBeInTheDocument(),
    );
    expect(input).toBeDisabled();
    expect(input.value).toBe("");
  });

  it("フォントで「カスタム」を選ぶと既定に戻らず入力欄が出る", async () => {
    renderWithProviders(<SettingsView theme="dark" onClose={() => {}} />);
    // ラベル検索は巨大な DOM では遅く 5 秒の既定タイムアウトに近づくため id で引く。
    await waitFor(() => expect(document.getElementById("settings-mono-font")).not.toBeNull());
    const select = document.getElementById("settings-mono-font") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__custom__" } });
    expect(select.value).toBe("__custom__");
    expect(
      document.querySelectorAll(`input[placeholder="${t("settingsFontCustomPlaceholder")}"]`).length,
    ).toBe(1);
  });
});
