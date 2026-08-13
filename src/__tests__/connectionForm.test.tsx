import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, act } from "./testUtils";
import { t } from "../i18n";
import type { ConnectionProfile } from "../api/tauri";

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      revealProfileSecret: vi.fn(),
    },
  };
});

import { ConnectionForm } from "../components/ConnectionForm";
import { api } from "../api/tauri";

/**
 * 接続フォーム (#604)。マウント時に Tauri 呼び出しを持たない (テスト接続 / 保存は
 * ボタン押下時のみ)。新規作成時に例外なくマウントでき、保存 / テスト / キャンセルの
 * 主要ボタンが可視であること・キャンセルで `onCancel` が呼ばれることを固定する。
 */
describe("ConnectionForm render smoke (#604)", () => {
  it("mounts for a new profile and shows the primary action buttons", () => {
    renderWithProviders(
      <ConnectionForm
        initial={null}
        profiles={[]}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: t("formSave") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("formTest") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("formCancel") })).toBeInTheDocument();
  });

  it("invokes onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <ConnectionForm
        initial={null}
        profiles={[]}
        onSaved={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("formCancel") }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

/**
 * 保存済みパスワードの表示 (#938)。keyring の値をフロントへ返す唯一の経路
 * (`revealProfileSecret`) が、保存済みプロファイルでだけ・明示クリックでだけ
 * 呼ばれ、非表示に戻すと平文が画面から消えることを固定する。
 */
describe("ConnectionForm reveals a stored password (#938)", () => {
  const saved: ConnectionProfile = {
    id: "abcd2345",
    name: "Prod",
    driver: "mysql",
    host: "db.example.com",
    port: 3306,
    user: "root",
    database: null,
    ssh: null,
    group: null,
    color: null,
    is_production: false,
    confirm_writes: false,
    read_only: false,
    skip_history: false,
    file_path: null,
    has_db_password: true,
  };

  const reveal = vi.mocked(api.revealProfileSecret);

  function renderForm(initial: ConnectionProfile | null) {
    renderWithProviders(
      <ConnectionForm initial={initial} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
  }

  /** DB パスワード欄 (SSH 側の欄と取り違えないよう label 経由で引く)。 */
  function passwordField(): HTMLInputElement {
    return screen.getByLabelText(t("formDbPassword")) as HTMLInputElement;
  }

  beforeEach(() => {
    reveal.mockReset();
  });

  it("fetches the secret from the keyring on click and shows it in the field", async () => {
    reveal.mockResolvedValue("s3cret-pw");
    renderForm(saved);

    // 保存済みなので、押す前はマスクのプレースホルダのまま (値は未取得)。
    expect(passwordField().value).not.toBe("s3cret-pw");
    expect(reveal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t("formPasswordReveal") }));

    await waitFor(() => expect(passwordField().value).toBe("s3cret-pw"));
    expect(reveal).toHaveBeenCalledWith("abcd2345", "db_password");
    // 平文表示中は入力ではなく閲覧 (誤って上書き保存しないよう read-only)。
    expect(passwordField()).toHaveAttribute("readonly");
    expect(passwordField().type).toBe("text");
  });

  it("drops the plaintext from the field when toggled back off", async () => {
    reveal.mockResolvedValue("s3cret-pw");
    renderForm(saved);
    fireEvent.click(screen.getByRole("button", { name: t("formPasswordReveal") }));
    await waitFor(() => expect(passwordField().value).toBe("s3cret-pw"));

    fireEvent.click(screen.getByRole("button", { name: t("formPasswordHide") }));
    await waitFor(() => expect(passwordField().value).not.toBe("s3cret-pw"));
    expect(passwordField().type).toBe("password");
  });

  // 表示しっぱなしで席を離れても平文が残らないことを担保する経路。壊れると
  // 画面に秘密が残り続けるので、タイマー経過の破棄も固定しておく。
  it("re-masks on its own once the reveal timeout elapses", async () => {
    reveal.mockResolvedValue("s3cret-pw");
    // 自動再マスクの `setTimeout` は reveal 成功時に張られるので、偽タイマーは
    // クリック**前**に入れておく必要がある。読み出しの解決はマイクロタスクなので
    // 偽タイマー下でも `act` のフラッシュだけで進む (`waitFor` は使わない)。
    vi.useFakeTimers();
    try {
      renderForm(saved);
      fireEvent.click(screen.getByRole("button", { name: t("formPasswordReveal") }));
      await act(async () => {});
      expect(passwordField().value).toBe("s3cret-pw");

      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(passwordField().value).not.toBe("s3cret-pw");
      expect(passwordField().type).toBe("password");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a keyring entry that disappeared instead of showing an empty value", async () => {
    reveal.mockResolvedValue(null);
    renderForm(saved);
    fireEvent.click(screen.getByRole("button", { name: t("formPasswordReveal") }));

    await waitFor(() =>
      expect(screen.getByText(t("formPasswordRevealMissing"))).toBeInTheDocument(),
    );
  });

  it("surfaces a keyring read failure", async () => {
    reveal.mockRejectedValue(new Error("keyring locked"));
    renderForm(saved);
    fireEvent.click(screen.getByRole("button", { name: t("formPasswordReveal") }));

    await waitFor(() =>
      expect(screen.getByText(/keyring locked/)).toBeInTheDocument(),
    );
  });

  it("keeps the plain show/hide toggle (no keyring read) for an unsaved profile", () => {
    renderForm(null);
    // 未保存プロファイルには keyring エントリが無いため、reveal の導線を出さない。
    expect(screen.queryByRole("button", { name: t("formPasswordReveal") })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: t("formPasswordShow") }));
    expect(reveal).not.toHaveBeenCalled();
  });

  it("does not read the keyring once the user typed a replacement", () => {
    renderForm(saved);
    fireEvent.change(passwordField(), { target: { value: "typed-new" } });

    // 入力済みの値は手元にあるので、切り替えは単なる表示トグル。
    fireEvent.click(screen.getByRole("button", { name: t("formPasswordShow") }));
    expect(reveal).not.toHaveBeenCalled();
    expect(passwordField().value).toBe("typed-new");
  });
});
