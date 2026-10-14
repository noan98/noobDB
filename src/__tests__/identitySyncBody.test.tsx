import { describe, expect, it } from "vitest";
import { IdentitySyncBody } from "../components/IdentitySyncBody";
import { t } from "../i18n";
import { fireEvent, renderWithProviders, screen } from "./testUtils";

describe("IdentitySyncBody (#1602)", () => {
  it("スイッチで「下げる」を切り替えると、プレビューと通知が変わる", () => {
    const seen: boolean[] = [];
    renderWithProviders(
      <IdentitySyncBody
        table="orders"
        column="id"
        showLower
        buildSql={(lower) => (lower ? "LOWER SQL" : "KEEP SQL")}
        onLowerChange={(l) => seen.push(l)}
      />,
    );
    expect(screen.getByText("KEEP SQL")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("LOWER SQL")).toBeInTheDocument();
    expect(seen).toEqual([true]);
  });

  it("SQLite (showLower=false) ではスイッチを出さない", () => {
    renderWithProviders(
      <IdentitySyncBody table="t" column="id" showLower={false} buildSql={() => "S"} onLowerChange={() => {}} />,
    );
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText(t("identitySyncLower"))).not.toBeInTheDocument();
  });

  it("現在値を読めないときは理由を FieldError で示す", () => {
    renderWithProviders(
      <IdentitySyncBody
        table="t"
        column="id"
        showLower
        unavailable="読めません"
        buildSql={(l) => (l ? "S" : null)}
        onLowerChange={() => {}}
      />,
    );
    expect(screen.getByText("読めません")).toBeInTheDocument();
  });
});
