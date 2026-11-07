import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { JobOutcome, JobProgressDetail } from "../components/JobProgress";

// 長時間 I/O の共通進捗部品 (#2122)。総数不定・0 件・完了時 100% の境界を固定する。
describe("JobProgressDetail", () => {
  it("total=null ではバーも ETA も出さず、タイル (件数・経過・速度) だけ出す", () => {
    renderWithProviders(
      <JobProgressDetail
        done={500}
        total={null}
        elapsedMs={5000}
        running
        rate={{ label: "Rows / sec", count: 500 }}
        stats={[{ label: "Rows", value: 500 }]}
        testId="d"
      />,
    );
    expect(screen.queryByText(/%$/)).toBeNull();
    expect(screen.queryByText(/ETA/)).toBeNull();
    expect(screen.getByText("Rows")).toBeInTheDocument();
    expect(screen.getByText("Rows / sec")).toBeInTheDocument();
    expect(screen.getByText("0:05")).toBeInTheDocument();
    expect(screen.getByText("100 / s")).toBeInTheDocument();
  });

  it("実行中は割合と、算出できるまで ETA 算出中を出す", () => {
    renderWithProviders(<JobProgressDetail done={0} total={100} elapsedMs={0} running />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText(/calculating/)).toBeInTheDocument();
  });

  it("進捗があれば ETA を出す", () => {
    renderWithProviders(<JobProgressDetail done={25} total={100} elapsedMs={10_000} running />);
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("ETA 0:30")).toBeInTheDocument();
  });

  it("total=0 (0 件) はバーを出さない", () => {
    renderWithProviders(<JobProgressDetail done={0} total={0} elapsedMs={1000} running />);
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it("速度は done ではなく rate.count から計算する (done と件数が別)", () => {
    // done=テーブル 2 個目、速度の件数は累計 1000 行。
    renderWithProviders(
      <JobProgressDetail done={2} total={10} elapsedMs={10_000} rate={{ label: "Rate", count: 1000 }} />,
    );
    expect(screen.getByText("100 / s")).toBeInTheDocument();
  });

  it("速度は経過 1 秒未満なら - にする", () => {
    renderWithProviders(
      <JobProgressDetail done={10} total={null} elapsedMs={200} rate={{ label: "Rate", count: 10 }} />,
    );
    expect(screen.getByText("-")).toBeInTheDocument();
  });
});

describe("JobOutcome", () => {
  it("完了は 100% で止め、Callout (role=status) と子要素を出す", () => {
    renderWithProviders(
      <JobOutcome kind="done" detail={{ done: 3, total: 10, elapsedMs: 4000 }} message="Done 3 inserted">
        <button type="button">save</button>
      </JobOutcome>,
    );
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Done 3 inserted");
    expect(screen.getByRole("button", { name: "save" })).toBeInTheDocument();
    expect(screen.queryByText(/ETA/)).toBeNull();
  });

  it("中断は割合を保ったまま警告、失敗は alert", () => {
    const { unmount } = renderWithProviders(
      <JobOutcome kind="cancelled" detail={{ done: 3, total: 10, elapsedMs: 1000 }} message="stopped" />,
    );
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("stopped");
    unmount();
    renderWithProviders(<JobOutcome kind="error" message="failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("failed");
  });
});
