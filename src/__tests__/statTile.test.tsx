import { describe, it, expect } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { StatTile } from "../components/StatTile";

/** StatTile のデルタ行 (向き・良悪) と inline sparkline (#1833)。 */
describe("StatTile delta / trend (#1833)", () => {
  it("delta も trend も未指定なら従来どおり (デルタ行も sparkline も出さない)", () => {
    renderWithProviders(<StatTile label="Rows" value="12" sub="x" />);
    expect(screen.queryByTestId("stat-delta")).not.toBeInTheDocument();
    expect(screen.queryByTestId("neutral-sparkline")).not.toBeInTheDocument();
  });

  it("増加が良い指標で増えたら textSuccess + ▲ + 読み上げ文言", () => {
    renderWithProviders(<StatTile label="QPS" value="10" delta={3} goodWhen="up" />);
    const el = screen.getByTestId("stat-delta");
    expect(el).toHaveAttribute("data-direction", "up");
    expect(el).toHaveAttribute("data-verdict", "good");
    expect(el.textContent).toContain("▲");
    expect(el).toHaveStyle({ color: "var(--chakra-colors-app-text-success)" });
    expect(el.textContent).toContain(t("statDeltaUpGood", { amount: "3" }));
  });

  it("増加が悪い指標で増えたら textError、減ったら textSuccess + ▼", () => {
    const { rerender } = renderWithProviders(<StatTile label="Locks" value="5" delta={2} goodWhen="down" />);
    expect(screen.getByTestId("stat-delta")).toHaveAttribute("data-verdict", "bad");
    expect(screen.getByTestId("stat-delta")).toHaveStyle({ color: "var(--chakra-colors-app-text-error)" });
    rerender(<StatTile label="Locks" value="3" delta={-2} goodWhen="down" />);
    const el = screen.getByTestId("stat-delta");
    expect(el).toHaveAttribute("data-verdict", "good");
    expect(el.textContent).toContain("▼");
    expect(el.textContent).toContain(t("statDeltaDownGood", { amount: "2" }));
  });

  it("neutral と 0 は良悪を付けず無彩色", () => {
    const { rerender } = renderWithProviders(<StatTile label="Conn" value="5" delta={4} />);
    expect(screen.getByTestId("stat-delta")).toHaveAttribute("data-verdict", "none");
    expect(screen.getByTestId("stat-delta")).toHaveStyle({ color: "var(--chakra-colors-app-text-muted)" });
    rerender(<StatTile label="Conn" value="5" delta={0} goodWhen="down" />);
    const el = screen.getByTestId("stat-delta");
    expect(el).toHaveAttribute("data-direction", "flat");
    expect(el).toHaveAttribute("data-verdict", "none");
    expect(el.textContent).toContain(t("statDeltaFlat"));
  });

  it("delta が null / 非有限なら行を出さない", () => {
    const { rerender } = renderWithProviders(<StatTile label="A" value="1" delta={null} />);
    expect(screen.queryByTestId("stat-delta")).not.toBeInTheDocument();
    rerender(<StatTile label="A" value="1" delta={Number.NaN} />);
    expect(screen.queryByTestId("stat-delta")).not.toBeInTheDocument();
  });

  it("deltaFormatter で差分の表記を変えられる", () => {
    renderWithProviders(<StatTile label="P" value="1" delta={-12.5} deltaFormatter={(n) => `${n}%`} />);
    expect(screen.getByTestId("stat-delta").textContent).toContain("12.5%");
  });

  it("trend が 2 点以上なら sparkline、1 点以下なら出さない", () => {
    const { rerender } = renderWithProviders(<StatTile label="T" value="1" trend={[1, 2, 3]} />);
    expect(screen.getByTestId("neutral-sparkline")).toBeInTheDocument();
    rerender(<StatTile label="T" value="1" trend={[1]} />);
    expect(screen.queryByTestId("neutral-sparkline")).not.toBeInTheDocument();
    rerender(<StatTile label="T" value="1" trend={[1, null]} />);
    expect(screen.queryByTestId("neutral-sparkline")).not.toBeInTheDocument();
  });

  it("整形後に 0 と同じになる揺らぎは変化なし (色なし)", () => {
    renderWithProviders(
      <StatTile label="R" value="1" delta={0.0000001} goodWhen="down" formatter={(n) => n.toFixed(2)} />,
    );
    const el = screen.getByTestId("stat-delta");
    expect(el).toHaveAttribute("data-direction", "flat");
    expect(el).toHaveAttribute("data-verdict", "none");
  });

  it("NaN を含む trend は有効点が 2 未満なら出さない", () => {
    renderWithProviders(<StatTile label="T" value="1" trend={[1, Number.NaN]} />);
    expect(screen.queryByTestId("neutral-sparkline")).not.toBeInTheDocument();
  });
});
