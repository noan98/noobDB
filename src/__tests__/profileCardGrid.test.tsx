import { describe, it, expect, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { ProfileCardGrid } from "../components/ProfileCardGrid";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * 未接続スタート画面のプロファイルカード (#874)。プロファイルが 1 件以上ある
 * 未接続時にメインペインへ表示する「入口」カードを固定する。バッジ/チップは
 * ProfileBadge.tsx、ドライバのアイコン/色は profileIdentity.ts を共有するため、
 * ここでは配線 (名前・接続先要約・バッジ・コールバック・接続中の抑止) を検証する。
 */
describe("ProfileCardGrid (#874)", () => {
  const profiles = [
    makeProfile({ id: "p-a", name: "Alpha DB", host: "db.example.com", port: 3306, user: "app" }),
    makeProfile({
      id: "p-b",
      name: "Prod PG",
      driver: "postgres",
      is_production: true,
      read_only: true,
      group: "Billing",
    }),
  ];

  it("renders a card per profile with its endpoint summary", () => {
    renderWithProviders(
      <ProfileCardGrid profiles={profiles} connectingId={null} onConnect={() => {}} onCreate={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Alpha DB" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prod PG" })).toBeInTheDocument();
    expect(screen.getByText("app@db.example.com:3306/appdb")).toBeInTheDocument();
  });

  it("shows production / read-only badges and the group name", () => {
    renderWithProviders(
      <ProfileCardGrid profiles={profiles} connectingId={null} onConnect={() => {}} onCreate={() => {}} />,
    );
    expect(screen.getByText(t("listProduction"))).toBeInTheDocument();
    expect(screen.getByText(t("listReadOnly"))).toBeInTheDocument();
    expect(screen.getByText("Billing")).toBeInTheDocument();
  });

  it("invokes onConnect with the clicked profile", () => {
    const onConnect = vi.fn();
    renderWithProviders(
      <ProfileCardGrid profiles={profiles} connectingId={null} onConnect={onConnect} onCreate={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Alpha DB" }));
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onConnect.mock.calls[0][0].id).toBe("p-a");
  });

  it("invokes onCreate from the new-connection card", () => {
    const onCreate = vi.fn();
    renderWithProviders(
      <ProfileCardGrid profiles={profiles} connectingId={null} onConnect={() => {}} onCreate={onCreate} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("profileCardsNew") }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it("disables other cards while a connection attempt is in flight", () => {
    const onConnect = vi.fn();
    renderWithProviders(
      <ProfileCardGrid profiles={profiles} connectingId="p-b" onConnect={onConnect} onCreate={() => {}} />,
    );
    const busy = screen.getByRole("button", { name: "Prod PG" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    const other = screen.getByRole("button", { name: "Alpha DB" });
    expect(other).toBeDisabled();
    fireEvent.click(other);
    expect(onConnect).not.toHaveBeenCalled();
  });
});
