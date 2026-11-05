import { act } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { ProfileCardGrid } from "../components/ProfileCardGrid";
import { makeProfile } from "./fixtures/componentFixtures";
import type { ConnectionProfile } from "../api/tauri";
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
    // 本番 / 読み取り専用の状態は accessible name に含める (#1529)。
    expect(
      screen.getByRole("button", {
        name: `Prod PG, ${t("profileCardStatusProduction")}, ${t("profileCardStatusReadOnly")}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("app@db.example.com:3306/appdb")).toBeInTheDocument();
  });

  it("places the decorative hero rule right under the display heading (#1891)", () => {
    renderWithProviders(
      <ProfileCardGrid profiles={profiles} connectingId={null} onConnect={() => {}} onCreate={() => {}} />,
    );
    // HeroHeader (#1955) では見出し行 (BrandMark + 見出し) の直下に罫線が来る。
    const rule = screen.getByRole("heading", { name: t("profileCardsTitle") }).parentElement
      ?.nextElementSibling;
    expect(rule).toHaveAttribute("aria-hidden", "true");
  });

  it("shows the brand mark next to the display heading, symmetric with WelcomeView (#1955)", () => {
    renderWithProviders(
      <ProfileCardGrid profiles={profiles} connectingId={null} onConnect={() => {}} onCreate={() => {}} />,
    );
    const row = screen.getByRole("heading", { name: t("profileCardsTitle") }).parentElement;
    expect(row?.querySelector("svg")).toBeTruthy();
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
    const busy = screen.getByRole("button", { name: /^Prod PG/ });
    expect(busy).toHaveAttribute("aria-busy", "true");
    const other = screen.getByRole("button", { name: "Alpha DB" });
    expect(other).toBeDisabled();
    fireEvent.click(other);
    expect(onConnect).not.toHaveBeenCalled();
  });
});

describe("ProfileCardGrid の検索とグループ絞り込み (#1630)", () => {
  const many = Array.from({ length: 7 }, (_, i) =>
    makeProfile({
      id: `p-${i}`,
      name: `Conn ${i}`,
      host: `host-${i}.example.com`,
      group: i < 3 ? "Billing" : i < 5 ? "Ops" : null,
    }),
  );

  it("件数が少ないうちは検索欄を出さない", () => {
    renderWithProviders(
      <ProfileCardGrid
        profiles={many.slice(0, 3)}
        connectingId={null}
        onConnect={() => {}}
        onCreate={() => {}}
      />,
    );
    expect(screen.queryByTestId("profile-cards-search")).not.toBeInTheDocument();
  });

  it("名前・ホストで絞り込み、一致が無ければ案内を出す", () => {
    renderWithProviders(
      <ProfileCardGrid profiles={many} connectingId={null} onConnect={() => {}} onCreate={() => {}} />,
    );
    const search = screen.getByTestId("profile-cards-search");
    fireEvent.change(search, { target: { value: "host-4" } });
    expect(screen.getByRole("button", { name: "Conn 4" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conn 1" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText(t("profileCardsNoMatches"))).toBeInTheDocument();
  });

  it("グループのチップで絞り込み、もう一度押すと解除する", () => {
    renderWithProviders(
      <ProfileCardGrid profiles={many} connectingId={null} onConnect={() => {}} onCreate={() => {}} />,
    );
    const chip = screen.getByRole("button", { name: "Ops" });
    fireEvent.click(chip);
    expect(screen.getByRole("button", { name: "Conn 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conn 0" })).not.toBeInTheDocument();
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chip);
    expect(screen.getByRole("button", { name: "Conn 0" })).toBeInTheDocument();
  });

  it("カードの右クリックから編集・複製・削除 (確認付き) へ行ける", async () => {
    const onEdit = vi.fn();
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    renderWithProviders(
      <ProfileCardGrid
        profiles={many.slice(0, 2)}
        connectingId={null}
        onConnect={() => {}}
        onCreate={() => {}}
        onEdit={onEdit}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "Conn 0" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("contextMenuEdit") }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "p-0" }));

    fireEvent.contextMenu(screen.getByRole("button", { name: "Conn 1" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("contextMenuDuplicate") }));
    expect(onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: "p-1" }));

    fireEvent.contextMenu(screen.getByRole("button", { name: "Conn 1" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: t("contextMenuDelete") }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: t("contextMenuDelete") }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "p-1" })));
  });

  describe("接続経路図 (#2031)", () => {
    afterEach(() => vi.useRealTimers());
    const ssh = makeProfile({
      id: "p-ssh",
      name: "Via Bastion",
      ssh: { host: "bastion.example.com", port: 22 } as ConnectionProfile["ssh"],
    });
    const diagramOf = (name: string) =>
      screen.getByRole("button", { name }).querySelector('[data-testid="connection-path-diagram"]');

    it("各カードに静的な経路プレビューを出し、SSH は踏み台ノードを含む。SQLite は出さない", () => {
      renderWithProviders(
        <ProfileCardGrid
          profiles={[ssh, makeProfile({ id: "p-l", name: "Local", driver: "sqlite", file_path: "/a.db" })]}
          connectingId={null}
          onConnect={() => {}}
          onCreate={() => {}}
        />,
      );
      const d = diagramOf("Via Bastion");
      expect(d).not.toBeNull();
      expect(d?.querySelector('[data-testid="conn-path-node-bastion"]')).not.toBeNull();
      expect(d?.getAttribute("data-phase")).toBeNull();
      expect(diagramOf("Local")).toBeNull();
    });

    it("接続中は phase を流し、一定時間後に prominent (ラベル付き) へ昇格する", () => {
      vi.useFakeTimers();
      renderWithProviders(
        <ProfileCardGrid
          profiles={[ssh]}
          connectingId="p-ssh"
          connectPhase="tunnel_connecting"
          onConnect={() => {}}
          onCreate={() => {}}
        />,
      );
      expect(diagramOf("Via Bastion")?.getAttribute("data-phase")).toBe("tunnel_connecting");
      const wrap = () => screen.getByTestId("profile-card-path");
      expect(wrap().getAttribute("data-promoted")).toBe("false");
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(wrap().getAttribute("data-promoted")).toBe("true");
      // 昇格後も図は compact のまま、目標の host:port を 1 行で図の下に出す。
      const target = screen.getByTestId("profile-card-path-target");
      expect(target).toHaveTextContent("127.0.0.1:3306");
      expect(target).toHaveAttribute("title", "127.0.0.1:3306");
    });

    it("別のカードが接続中のとき、自分のカードには phase が付かず昇格もしない", () => {
      vi.useFakeTimers();
      const other = makeProfile({ id: "p-o", name: "Other" });
      renderWithProviders(
        <ProfileCardGrid
          profiles={[ssh, other]}
          connectingId="p-o"
          connectPhase="db_connecting"
          onConnect={() => {}}
          onCreate={() => {}}
        />,
      );
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(diagramOf("Via Bastion")?.getAttribute("data-phase")).toBeNull();
      expect(diagramOf("Other")?.getAttribute("data-phase")).toBe("db_connecting");
      const wraps = screen.getAllByTestId("profile-card-path");
      expect(wraps[0].getAttribute("data-promoted")).toBe("false");
      expect(wraps[1].getAttribute("data-promoted")).toBe("true");
    });
  });
});
