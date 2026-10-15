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
      testConnection: vi.fn(),
      saveProfile: vi.fn(),
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
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByRole("button", { name: t("formSave") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("formTest") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("formCancel") })).toBeInTheDocument();
  });

  it("invokes onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={onCancel} />,
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

    await waitFor(() => expect(screen.getByText(t("formPasswordRevealMissing"))).toBeInTheDocument());
  });

  it("surfaces a keyring read failure", async () => {
    reveal.mockRejectedValue(new Error("keyring locked"));
    renderForm(saved);
    fireEvent.click(screen.getByRole("button", { name: t("formPasswordReveal") }));

    await waitFor(() => expect(screen.getByText(/keyring locked/)).toBeInTheDocument());
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

/**
 * 接続テスト結果のインラインフィードバック (#1006)。
 *
 * - 成功/失敗バナーは意味のある role (`status`/`alert`) + `aria-live` で
 *   支援技術へ通知される。
 * - ポートのバリデーション失敗は「接続テスト結果」バナーではなく、該当
 *   フィールド直下のインラインエラー (`aria-invalid` 付き) として現れる。
 */
describe("ConnectionForm connection test feedback (#1006)", () => {
  const testConnection = vi.mocked(api.testConnection);

  function portField(): HTMLInputElement {
    return screen.getByLabelText(t("formPort")) as HTMLInputElement;
  }

  beforeEach(() => {
    testConnection.mockReset();
  });

  it("shows a success banner with role=status when the test connection succeeds", async () => {
    testConnection.mockResolvedValue("ok");
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));

    // `getByRole("status")` alone would also match the Test ボタンの読み込み中
    // スピナー (LoadingButton の `Spinner`、`aria-label="loading"`)、なので
    // メッセージのテキストからバナー本体を辿って区別する。
    const messageNode = await screen.findByText(t("formConnectionOk"));
    const banner = messageNode.closest('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner).toHaveAttribute("aria-live", "polite");
    // 失敗バナー用の role="alert" は存在しない。
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the success banner once the connection input is edited (#1593)", async () => {
    testConnection.mockResolvedValue("ok");
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    await screen.findByText(t("formConnectionOk"));
    fireEvent.change(screen.getByLabelText(t("formHost")), { target: { value: "other-host" } });
    await waitFor(() => expect(screen.queryByText(t("formConnectionOk"))).toBeNull());
  });

  it("shows a danger banner with role=alert when the test connection fails", async () => {
    testConnection.mockRejectedValue(new Error("boom"));
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));

    const messageNode = await screen.findByText(/boom/);
    const banner = messageNode.closest('[role="alert"]');
    expect(banner).not.toBeNull();
    expect(banner).toHaveAttribute("aria-live", "assertive");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("rejects an invalid port as an inline field error, not the test-result banner", () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );

    fireEvent.change(portField(), { target: { value: "700000" } });
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));

    // フィールド直下のインラインエラー。
    expect(screen.getByText(t("formInvalidPort"))).toBeInTheDocument();
    expect(portField()).toHaveAttribute("aria-invalid", "true");
    // 集約バナー (接続テスト結果専用) は表示されず、alert はフィールド直下の
    // インラインエラー 1 件のみ。IPC も呼ばれない。
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("clears the inline port error once the user edits the field again", () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );

    fireEvent.change(portField(), { target: { value: "700000" } });
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    expect(portField()).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(portField(), { target: { value: "5432" } });
    expect(portField()).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText(t("formInvalidPort"))).toBeNull();
  });
});

/**
 * AWS RDS IAM 認証 (#734)。認証方式に AWS IAM を選ぶとパスワード欄が消え、
 * 接続要求はパスワード無し + `aws_iam` + TLS 強制 (`require` 以上) になること、
 * 保存時にも AWS のキーではなくリージョン / プロファイル名だけが送られることを固定する。
 */
describe("ConnectionForm AWS IAM authentication (#734)", () => {
  const testConnection = vi.mocked(api.testConnection);
  const saveProfile = vi.mocked(api.saveProfile);

  beforeEach(() => {
    testConnection.mockReset();
    saveProfile.mockReset();
  });

  function authSelect(): HTMLSelectElement {
    return screen.getByLabelText(t("formAuthMethod")) as HTMLSelectElement;
  }

  it("swaps the password field for region / profile and sends a TLS-forced IAM request", async () => {
    testConnection.mockResolvedValue("ok");
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(t("formHost")), {
      target: { value: "mydb.abc123.ap-northeast-1.rds.amazonaws.com" },
    });
    expect(screen.getByLabelText(t("formDbPassword"))).toBeInTheDocument();

    fireEvent.change(authSelect(), { target: { value: "aws_iam" } });
    expect(screen.queryByLabelText(t("formDbPassword"))).toBeNull();
    // リージョンはエンドポイント名から推定され、TLS の注記が出る。
    expect(screen.getByText(t("formAwsRegionInferred", { region: "ap-northeast-1" }))).toBeInTheDocument();
    expect(screen.getByTestId("aws-iam-tls-note")).toBeInTheDocument();
    // 平文を許すモードは選べず、既定の prefer は require に引き上げられる。
    const tls = screen.getByLabelText(t("formTlsMode")) as HTMLSelectElement;
    expect(tls.value).toBe("require");
    expect((tls.querySelector('option[value="disable"]') as HTMLOptionElement).disabled).toBe(true);
    expect((tls.querySelector('option[value="prefer"]') as HTMLOptionElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(t("formAwsProfile")), { target: { value: " work " } });
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    await screen.findByText(t("formConnectionOk"));

    const req = testConnection.mock.calls[0][0];
    expect(req.password).toBe("");
    expect(req.ssl_mode).toBe("require");
    expect(req.aws_iam).toEqual({ region: "", profile: "work" });
    expect(req.host).toBe("mydb.abc123.ap-northeast-1.rds.amazonaws.com");
  });

  it("warns when the region cannot be inferred from the host", () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(authSelect(), { target: { value: "aws_iam" } });
    expect(screen.getByRole("alert")).toHaveTextContent(t("formAwsRegionMissing"));
    fireEvent.change(screen.getByLabelText(t("formAwsRegion")), { target: { value: "us-east-1" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rejects a blank profile name without calling saveProfile (#1593)", async () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByTestId("connection-form-name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    expect(await screen.findByText(t("formNameRequired"))).toBeInTheDocument();
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it("restores a saved IAM profile and saves only non-secret IAM settings", async () => {
    saveProfile.mockResolvedValue({} as never);
    const onSaved = vi.fn();
    const saved: ConnectionProfile = {
      id: "iam00001",
      name: "RDS",
      driver: "postgres",
      host: "db.abc.us-west-2.rds.amazonaws.com",
      port: 5432,
      user: "app_iam",
      database: null,
      ssh: null,
      group: null,
      color: null,
      is_production: false,
      confirm_writes: false,
      read_only: false,
      skip_history: false,
      file_path: null,
      ssl_mode: "verify_full",
      aws_iam: { region: "us-west-2", profile: "prod" },
    };
    renderWithProviders(
      <ConnectionForm initial={saved} profiles={[saved]} onSaved={onSaved} onCancel={() => {}} />,
    );
    expect(authSelect().value).toBe("aws_iam");
    expect((screen.getByLabelText(t("formAwsRegion")) as HTMLInputElement).value).toBe("us-west-2");
    expect((screen.getByLabelText(t("formTlsMode")) as HTMLSelectElement).value).toBe("verify_full");

    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const req = saveProfile.mock.calls[0][0];
    expect(req.aws_iam).toEqual({ region: "us-west-2", profile: "prod" });
    expect(req.ssl_mode).toBe("verify_full");
    expect(req.db_password).toBeUndefined();
  });

  it("saves the user's chosen sslMode, not the IAM-forced one", async () => {
    saveProfile.mockResolvedValue({} as never);
    const onSaved = vi.fn();
    const saved: ConnectionProfile = {
      id: "iam00002",
      name: "RDS",
      driver: "postgres",
      host: "db.abc.us-west-2.rds.amazonaws.com",
      port: 5432,
      user: "app_iam",
      database: null,
      ssh: null,
      group: null,
      color: null,
      is_production: false,
      confirm_writes: false,
      read_only: false,
      skip_history: false,
      file_path: null,
      ssl_mode: "prefer",
      aws_iam: { region: "us-west-2", profile: null },
    };
    renderWithProviders(
      <ConnectionForm initial={saved} profiles={[saved]} onSaved={onSaved} onCancel={() => {}} />,
    );
    // 画面上は require に引き上げて表示される。
    expect((screen.getByLabelText(t("formTlsMode")) as HTMLSelectElement).value).toBe("require");
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saveProfile.mock.calls[0][0].ssl_mode).toBe("prefer");
  });

  it("does not offer IAM auth for SQLite (file-backed)", () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(t("formDriver")), { target: { value: "sqlite" } });
    expect(screen.queryByLabelText(t("formAuthMethod"))).toBeNull();
  });
});

/**
 * 接続 URL の取り込み (#1540)。URL をフォームの各欄へ反映し、パスワードは
 * パスワード欄 (保存時に keyring へ渡す db_password) にだけ入る。
 */
describe("ConnectionForm connection URL import (#1540)", () => {
  const saveProfile = vi.mocked(api.saveProfile);

  beforeEach(() => {
    saveProfile.mockReset();
  });

  function importUrl(url: string) {
    fireEvent.change(screen.getByTestId("connection-form-url"), { target: { value: url } });
    fireEvent.click(screen.getByTestId("connection-form-url-import"));
  }

  it("PostgreSQL の URL をドライバ・ホスト・ポート・ユーザー・DB・TLS・パスワードへ反映する", async () => {
    saveProfile.mockResolvedValue({} as never);
    const onSaved = vi.fn();
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={onSaved} onCancel={() => {}} />,
    );
    importUrl("postgresql://app:p%40ss@db.example.com:6543/shop?sslmode=verify-full&application_name=x");

    expect((screen.getByLabelText(t("formHost")) as HTMLInputElement).value).toBe("db.example.com");
    expect((screen.getByLabelText(t("formPort")) as HTMLInputElement).value).toBe("6543");
    expect((screen.getByLabelText(t("formUser")) as HTMLInputElement).value).toBe("app");
    expect((screen.getByLabelText(t("formDatabase")) as HTMLInputElement).value).toBe("shop");
    expect((screen.getByLabelText(t("formTlsMode")) as HTMLSelectElement).value).toBe("verify_full");
    expect((screen.getByTestId("connection-form-driver") as HTMLSelectElement).value).toBe("postgres");
    // 入力欄は消え、未対応パラメータの名前だけが案内される。
    expect((screen.getByTestId("connection-form-url") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("status")).toHaveTextContent("application_name");

    fireEvent.change(screen.getByTestId("connection-form-name"), { target: { value: "p" } });
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const req = saveProfile.mock.calls[0][0];
    expect(req.db_password).toBe("p@ss");
    // プロファイル本体 (profiles.json に書かれる側) にパスワードは含まれない。
    expect(JSON.stringify({ ...req, db_password: undefined })).not.toContain("p@ss");
    expect(req.port).toBe(6543);
    expect(req.ssl_mode).toBe("verify_full");
  });

  it("URL に無い項目 (DB 名・ポート) は、ドライバが同じなら現在の値を残す", () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    importUrl("postgres://h/shop");
    fireEvent.change(screen.getByLabelText(t("formPort")), { target: { value: "6543" } });
    importUrl("postgres://other-host");
    expect((screen.getByLabelText(t("formHost")) as HTMLInputElement).value).toBe("other-host");
    expect((screen.getByLabelText(t("formDatabase")) as HTMLInputElement).value).toBe("shop");
    expect((screen.getByLabelText(t("formPort")) as HTMLInputElement).value).toBe("6543");
  });

  it("ポート省略時はドライバの既定ポートに戻る", () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    importUrl("postgres://h/d");
    expect((screen.getByLabelText(t("formPort")) as HTMLInputElement).value).toBe("5432");
    expect((screen.getByLabelText(t("formUser")) as HTMLInputElement).value).toBe("postgres");
  });

  it("sqlite: とファイルパスは SQLite のファイルパス欄へ入る", () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    importUrl("sqlite:///var/data/app.db");
    expect((screen.getByTestId("connection-form-driver") as HTMLSelectElement).value).toBe("sqlite");
    expect((screen.getByTestId("connection-form-sqlite-path") as HTMLInputElement).value).toBe(
      "/var/data/app.db",
    );
  });

  it("不正な URL はエラーを出し、フォームを変えず、入力内容を表示しない", () => {
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    importUrl("mysql://u:topsecret@h:abc/d");
    expect(screen.getByRole("alert")).toHaveTextContent(t("formUrlErrPort"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("topsecret");
    expect((screen.getByLabelText(t("formHost")) as HTMLInputElement).value).toBe("127.0.0.1");
  });
});

/**
 * 接続経路 (直接 / SSH / SSM) の 3 択 (#1684)。選んだ経路の入力欄だけを出し、
 * ペイロードには選んだ経路だけを載せて他方は null にする。
 */
describe("ConnectionForm connection route (#1684)", () => {
  const saveProfile = vi.mocked(api.saveProfile);
  const testConnection = vi.mocked(api.testConnection);
  const base: ConnectionProfile = {
    id: "ssm00001",
    name: "Via SSM",
    driver: "mysql",
    host: "mydb.abc123.ap-northeast-1.rds.amazonaws.com",
    port: 3306,
    user: "app",
    database: null,
    ssh: null,
    group: null,
    color: null,
    is_production: false,
    confirm_writes: false,
    read_only: false,
    skip_history: false,
    file_path: null,
  };

  beforeEach(() => {
    saveProfile.mockReset();
    testConnection.mockReset();
  });

  const renderForm = (initial: ConnectionProfile | null) =>
    renderWithProviders(
      <ConnectionForm initial={initial} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
  const pick = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));

  it("shows only the fields of the selected route", () => {
    renderForm(null);
    expect(screen.getByRole("radio", { name: t("formRouteDirect") })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByLabelText(t("formSshHost"))).toBeNull();
    expect(screen.queryByLabelText(t("formSsmTarget"))).toBeNull();

    pick(t("formRouteSsh"));
    expect(screen.getByLabelText(t("formSshHost"))).toBeInTheDocument();
    expect(screen.queryByLabelText(t("formSsmTarget"))).toBeNull();

    pick(t("formRouteSsm"));
    expect(screen.getByLabelText(t("formSsmTarget"))).toBeInTheDocument();
    expect(screen.getByLabelText(t("formSsmRegion"))).toBeInTheDocument();
    expect(screen.getByLabelText(t("formSsmProfile"))).toBeInTheDocument();
    expect(screen.queryByLabelText(t("formSshHost"))).toBeNull();
  });

  it("sends only ssm (ssh null) on connection test", async () => {
    testConnection.mockResolvedValue("ok" as never);
    renderForm(null);
    pick(t("formRouteSsm"));
    fireEvent.change(screen.getByLabelText(t("formSsmTarget")), {
      target: { value: " i-0123456789abcdef0 " },
    });
    fireEvent.change(screen.getByLabelText(t("formSsmProfile")), { target: { value: " vault " } });
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    await waitFor(() => expect(testConnection).toHaveBeenCalled());
    const req = testConnection.mock.calls[0][0];
    expect(req.ssm).toEqual({ target: "i-0123456789abcdef0", region: "", profile: "vault" });
    expect(req.ssh).toBeNull();
  });

  it("sends only ssh (ssm null) when SSH is selected", async () => {
    testConnection.mockResolvedValue("ok" as never);
    renderForm(null);
    pick(t("formRouteSsm"));
    fireEvent.change(screen.getByLabelText(t("formSsmTarget")), { target: { value: "i-0123456789abcdef0" } });
    pick(t("formRouteSsh"));
    fireEvent.change(screen.getByLabelText(t("formSshHost")), { target: { value: "bastion.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    await waitFor(() => expect(testConnection).toHaveBeenCalled());
    const req = testConnection.mock.calls[0][0];
    expect(req.ssm).toBeNull();
    expect(req.ssh?.host).toBe("bastion.example.com");
  });

  it("rejects a malformed instance ID with an inline error and does not save", async () => {
    renderForm(null);
    fireEvent.change(screen.getByTestId("connection-form-name"), { target: { value: "X" } });
    pick(t("formRouteSsm"));
    fireEvent.change(screen.getByLabelText(t("formSsmTarget")), { target: { value: "i-XYZ" } });
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    expect(await screen.findByText(t("formInvalidSsmTarget"))).toBeInTheDocument();
    expect(screen.getByLabelText(t("formSsmTarget"))).toHaveAttribute("aria-invalid", "true");
    expect(saveProfile).not.toHaveBeenCalled();
  });

  it("rejects an empty instance ID on connection test", async () => {
    renderForm(null);
    pick(t("formRouteSsm"));
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    expect(await screen.findByText(t("formInvalidSsmTarget"))).toBeInTheDocument();
    expect(testConnection).not.toHaveBeenCalled();
  });

  it("restores a saved ssm profile and saves ssm with ssh null", async () => {
    saveProfile.mockResolvedValue({} as never);
    const saved: ConnectionProfile = {
      ...base,
      ssm: { target: "mi-0123456789abcdef0", region: "ap-northeast-1", profile: "vault" },
    };
    renderForm(saved);
    expect(screen.getByRole("radio", { name: t("formRouteSsm") })).toHaveAttribute("aria-checked", "true");
    expect((screen.getByLabelText(t("formSsmTarget")) as HTMLInputElement).value).toBe(
      "mi-0123456789abcdef0",
    );
    expect((screen.getByLabelText(t("formSsmRegion")) as HTMLInputElement).value).toBe("ap-northeast-1");
    expect((screen.getByLabelText(t("formSsmProfile")) as HTMLInputElement).value).toBe("vault");
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalled());
    const req = saveProfile.mock.calls[0][0];
    expect(req.ssm).toEqual({ target: "mi-0123456789abcdef0", region: "ap-northeast-1", profile: "vault" });
    expect(req.ssh).toBeNull();
  });

  it("restores a saved ssh profile as the SSH route", () => {
    renderForm({
      ...base,
      ssh: { host: "bastion", port: 22, user: "me", auth_method: "agent", private_key_path: "", jump: null },
    });
    expect(screen.getByRole("radio", { name: t("formRouteSsh") })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByLabelText(t("formSsmTarget"))).toBeNull();
  });

  it("hides the whole route radiogroup for SQLite and sends ssm null", async () => {
    saveProfile.mockResolvedValue({} as never);
    renderForm({
      ...base,
      driver: "sqlite",
      file_path: "/tmp/a.db",
      ssm: { target: "i-0123456789abcdef0", region: "" },
    });
    expect(screen.queryByRole("radiogroup", { name: t("formRoute") })).toBeNull();
    expect(screen.queryByLabelText(t("formSsmTarget"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalled());
    expect(saveProfile.mock.calls[0][0].ssm ?? null).toBeNull();
  });

  const fillSsh = () => {
    pick(t("formRouteSsh"));
    fireEvent.change(screen.getByLabelText(t("formSshHost")), { target: { value: "bastion.example.com" } });
    const sshAuth = document.querySelector('select[id$="-ssh-auth"]') as HTMLSelectElement;
    fireEvent.change(sshAuth, { target: { value: "password" } });
    fireEvent.change(screen.getByLabelText(t("formSshPassword")), { target: { value: "ssh-pw" } });
    fireEvent.click(screen.getByRole("switch", { name: t("formUseSshJump") }));
    const jumpAuth = document.querySelector('select[id$="-ssh-jump-auth"]') as HTMLSelectElement;
    fireEvent.change(jumpAuth, { target: { value: "password" } });
    fireEvent.change(document.querySelector('input[id$="-ssh-jump-password"]') as HTMLInputElement, {
      target: { value: "jump-pw" },
    });
  };

  it("drops ssh and its secrets when switching from SSH to SSM on save", async () => {
    saveProfile.mockResolvedValue({} as never);
    renderForm(null);
    fireEvent.change(screen.getByTestId("connection-form-name"), { target: { value: "X" } });
    fillSsh();
    pick(t("formRouteSsm"));
    fireEvent.change(screen.getByLabelText(t("formSsmTarget")), { target: { value: "i-0123456789abcdef0" } });
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalled());
    const req = saveProfile.mock.calls[0][0];
    expect(req.ssh).toBeNull();
    expect(req.ssh_password).toBeUndefined();
    expect(req.ssh_passphrase).toBeUndefined();
    expect(req.ssh_jump_password).toBeUndefined();
    expect(req.ssh_jump_passphrase).toBeUndefined();
    expect(req.ssm?.target).toBe("i-0123456789abcdef0");
  });

  it("drops ssh and its secrets when switching from SSH to direct on save", async () => {
    saveProfile.mockResolvedValue({} as never);
    renderForm(null);
    fireEvent.change(screen.getByTestId("connection-form-name"), { target: { value: "X" } });
    fillSsh();
    pick(t("formRouteDirect"));
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalled());
    const req = saveProfile.mock.calls[0][0];
    expect(req.ssh).toBeNull();
    expect(req.ssm ?? null).toBeNull();
    expect(req.ssh_password).toBeUndefined();
    expect(req.ssh_passphrase).toBeUndefined();
  });

  it("sends neither ssh nor ssm when switching from SSM to direct", async () => {
    testConnection.mockResolvedValue("ok" as never);
    renderForm(null);
    pick(t("formRouteSsm"));
    fireEvent.change(screen.getByLabelText(t("formSsmTarget")), { target: { value: "i-0123456789abcdef0" } });
    pick(t("formRouteDirect"));
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    await waitFor(() => expect(testConnection).toHaveBeenCalled());
    const req = testConnection.mock.calls[0][0];
    expect(req.ssh).toBeNull();
    expect(req.ssm).toBeNull();
  });

  it("trims the region and turns a whitespace-only profile into null", async () => {
    testConnection.mockResolvedValue("ok" as never);
    renderForm(null);
    pick(t("formRouteSsm"));
    fireEvent.change(screen.getByLabelText(t("formSsmTarget")), { target: { value: "i-0123456789abcdef0" } });
    fireEvent.change(screen.getByLabelText(t("formSsmRegion")), { target: { value: " us-west-2 " } });
    fireEvent.change(screen.getByLabelText(t("formSsmProfile")), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    await waitFor(() => expect(testConnection).toHaveBeenCalled());
    expect(testConnection.mock.calls[0][0].ssm).toEqual({
      target: "i-0123456789abcdef0",
      region: "us-west-2",
      profile: null,
    });
  });

  it("rejects a malformed region with an inline error", async () => {
    renderForm(null);
    pick(t("formRouteSsm"));
    fireEvent.change(screen.getByLabelText(t("formSsmTarget")), { target: { value: "i-0123456789abcdef0" } });
    fireEvent.change(screen.getByLabelText(t("formSsmRegion")), { target: { value: "US West!" } });
    fireEvent.click(screen.getByRole("button", { name: t("formTest") }));
    expect(await screen.findByText(t("formInvalidSsmRegion"))).toBeInTheDocument();
    expect(testConnection).not.toHaveBeenCalled();
  });
});

/**
 * 接続 URL のコピー (#1630) とトンネルのローカルポート固定 (#1630)。
 */
describe("ConnectionForm URL copy and fixed tunnel port (#1630)", () => {
  const saveProfile = vi.mocked(api.saveProfile);

  beforeEach(() => {
    saveProfile.mockReset();
  });

  it("現在の入力から接続 URL をコピーし、パスワードは含めない", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(t("formHost")), { target: { value: "db.example.com" } });
    fireEvent.change(screen.getByLabelText(t("formUser")), { target: { value: "app" } });
    fireEvent.change(screen.getByLabelText(t("formDatabase")), { target: { value: "shop" } });
    fireEvent.change(screen.getByLabelText(t("formDbPassword")), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("connection-form-url-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toMatch(/^mysql:\/\/app@db\.example\.com:3306\/shop\?ssl-mode=/);
    expect(copied).not.toContain("s3cret");
  });

  it("ホスト未入力のときはコピーせず案内を出す", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    renderWithProviders(
      <ConnectionForm initial={null} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(t("formHost")), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("connection-form-url-copy"));
    expect(await screen.findByText(t("formUrlCopyEmpty"))).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  const sshProfile: ConnectionProfile = {
    id: "abcd2345",
    name: "Tunnel",
    driver: "mysql",
    host: "10.0.0.5",
    port: 3306,
    user: "root",
    database: null,
    ssh: {
      host: "bastion",
      port: 22,
      user: "ops",
      auth_method: "agent",
      private_key_path: "",
      local_port: 15432,
    },
    group: null,
    color: null,
    is_production: false,
    confirm_writes: false,
    read_only: false,
    skip_history: false,
    file_path: null,
  };

  it("固定ポートを保存でき、空にすると自動割当 (null) に戻る", async () => {
    saveProfile.mockResolvedValue({} as never);
    const onSaved = vi.fn();
    renderWithProviders(
      <ConnectionForm initial={sshProfile} profiles={[]} onSaved={onSaved} onCancel={() => {}} />,
    );
    const input = screen.getByLabelText(t("formSshLocalPort")) as HTMLInputElement;
    expect(input.value).toBe("15432");
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalledOnce());
    expect(saveProfile.mock.calls[0][0].ssh?.local_port).toBe(15432);

    saveProfile.mockClear();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    await waitFor(() => expect(saveProfile).toHaveBeenCalledOnce());
    expect(saveProfile.mock.calls[0][0].ssh?.local_port).toBeNull();
  });

  it("範囲外のポートは保存せずフィールドにエラーを出す", async () => {
    renderWithProviders(
      <ConnectionForm initial={sshProfile} profiles={[]} onSaved={() => {}} onCancel={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText(t("formSshLocalPort")), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: t("formSave") }));
    expect(await screen.findByText(t("formInvalidSshLocalPort"))).toBeInTheDocument();
    expect(saveProfile).not.toHaveBeenCalled();
  });
});
