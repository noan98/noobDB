import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";

const listKnownHosts = vi.fn();
const listKnownHostsHistory = vi.fn();
const scanOpensshKnownHosts = vi.fn();
const importKnownHosts = vi.fn();
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listKnownHosts: (...a: unknown[]) => listKnownHosts(...a),
      listKnownHostsHistory: (...a: unknown[]) => listKnownHostsHistory(...a),
      scanOpensshKnownHosts: (...a: unknown[]) => scanOpensshKnownHosts(...a),
      importKnownHosts: (...a: unknown[]) => importKnownHosts(...a),
      forgetHostKey: vi.fn(),
    },
  };
});

import { KnownHostsPanel } from "../components/KnownHostsPanel";

beforeEach(() => {
  listKnownHostsHistory.mockResolvedValue([]);
  listKnownHosts.mockResolvedValue([
    { host: "bastion.example.com", port: 22, fingerprint: "SHA256:abcDEF" },
    { host: "db.example.com", port: 2222, fingerprint: "SHA256:zzz999" },
  ]);
});

describe("KnownHostsPanel の破棄確認 (#1534)", () => {
  it("確認ダイアログに、破棄する host:port とフィンガープリントを示す", async () => {
    const user = userEvent.setup();
    renderWithProviders(<KnownHostsPanel />);
    const forgets = await screen.findAllByRole("button", { name: t("knownHostsForget") });
    await user.click(forgets[1]);
    expect(
      await screen.findByText(
        t("knownHostsForgetConfirm", { host: "db.example.com:2222", fingerprint: "SHA256:zzz999" }),
      ),
    ).toBeInTheDocument();
  });
});

describe("KnownHostsPanel の履歴と OpenSSH 取り込み (#1630)", () => {
  it("信頼・破棄の履歴を時系列で表示し、置き換えられた旧指紋も示す", async () => {
    listKnownHostsHistory.mockResolvedValue([
      {
        at: "2026-10-15T01:02:03Z",
        action: "trust",
        host: "db.example.com",
        port: 2222,
        fingerprint: "SHA256:new",
        previous_fingerprint: "SHA256:old",
      },
      {
        at: "2026-10-14T01:02:03Z",
        action: "forget",
        host: "bastion.example.com",
        port: 22,
        fingerprint: "SHA256:abcDEF",
        previous_fingerprint: null,
      },
    ]);
    renderWithProviders(<KnownHostsPanel />);
    const history = await screen.findByTestId("known-hosts-history");
    expect(history).toHaveTextContent("db.example.com:2222");
    expect(history).toHaveTextContent(t("knownHostsActionTrust"));
    expect(history).toHaveTextContent(t("knownHostsActionForget"));
    expect(history).toHaveTextContent(t("knownHostsHistoryPrevious", { fingerprint: "SHA256:old" }));
  });

  it("取り込み候補を選んで取り込める (新規のみ初期選択、ハッシュ化は件数を表示)", async () => {
    scanOpensshKnownHosts.mockResolvedValue({
      found: true,
      candidates: [
        {
          host: "new.example.com",
          port: 22,
          fingerprint: "SHA256:n",
          key_type: "ssh-ed25519",
          status: "new",
          existing_fingerprint: null,
        },
        {
          host: "diff.example.com",
          port: 22,
          fingerprint: "SHA256:d",
          key_type: "ssh-ed25519",
          status: "conflict",
          existing_fingerprint: "SHA256:old",
        },
      ],
      hashed_skipped: 3,
      other_skipped: 0,
    });
    importKnownHosts.mockResolvedValue(1);
    const user = userEvent.setup();
    renderWithProviders(<KnownHostsPanel />);
    await user.click(await screen.findByRole("button", { name: t("knownHostsImportOpen") }));
    const box = await screen.findByTestId("known-hosts-import");
    expect(box).toHaveTextContent(t("knownHostsImportHashed", { count: 3 }));
    await user.click(screen.getByRole("button", { name: t("knownHostsImportRun") }));
    expect(importKnownHosts).toHaveBeenCalledWith([
      { host: "new.example.com", port: 22, fingerprint: "SHA256:n" },
    ]);
  });
});
