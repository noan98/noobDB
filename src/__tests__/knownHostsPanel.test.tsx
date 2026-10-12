import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";

const listKnownHosts = vi.fn();
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listKnownHosts: (...a: unknown[]) => listKnownHosts(...a),
      forgetHostKey: vi.fn(),
    },
  };
});

import { KnownHostsPanel } from "../components/KnownHostsPanel";

beforeEach(() => {
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
