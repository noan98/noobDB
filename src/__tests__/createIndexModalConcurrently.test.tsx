import { describe, it, expect, vi, beforeEach } from "vitest";
import { t } from "../i18n";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";

/** CreateIndexModal の CONCURRENTLY / ロック待ちの上限 (#2240)。 */
const stats = vi.hoisted(() => ({ rows: 5_000_000 as number | null }));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const col = (name: string) => ({
    name,
    data_type: "int",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  });
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: vi.fn().mockResolvedValue([col("a")]),
      checkDuplicateIndex: vi.fn().mockResolvedValue([]),
      tableRowEstimate: vi.fn(async () => stats.rows),
    },
  };
});

import { CreateIndexModal } from "../components/CreateIndexModal";
import type { DriverKind } from "../api/tauri";

function open(driver: DriverKind, onRun = vi.fn()) {
  renderWithProviders(
    <CreateIndexModal
      sessionId="s1"
      driver={driver}
      database="public"
      table="t"
      readOnly={false}
      onRun={onRun}
      onSendToEditor={() => {}}
      onClose={() => {}}
    />,
  );
  return onRun;
}

beforeEach(() => {
  stats.rows = 5_000_000;
});

describe("CreateIndexModal CONCURRENTLY (#2240)", () => {
  it("PostgreSQL の大きな表では既定でオン。トランザクション外の計画で実行する", async () => {
    const onRun = open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    await waitFor(() => expect(document.body.textContent).toContain("CREATE INDEX CONCURRENTLY"));
    expect(screen.getByTestId("create-index-concurrently-note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("createIndexRun") }));
    expect(onRun).toHaveBeenCalledOnce();
    const [sql, options] = onRun.mock.calls[0];
    expect(sql).toContain("CREATE INDEX CONCURRENTLY");
    expect(options.plan.steps).toHaveLength(1);
    expect(options.plan.steps[0].transactional).toBe(false);
  });

  it("小さい表では既定でオフ。トグルでオンにできる", async () => {
    stats.rows = 10;
    open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    await waitFor(() => expect(document.body.textContent).toContain('CREATE INDEX "idx_t_a"'));
    expect(document.body.textContent).not.toContain("INDEX CONCURRENTLY");
    fireEvent.click(screen.getByLabelText(t("createIndexConcurrentlyToggle")));
    await waitFor(() => expect(document.body.textContent).toContain("CREATE INDEX CONCURRENTLY"));
  });

  it("MySQL / SQLite には CONCURRENTLY のトグルが出ない", async () => {
    open("mysql");
    fireEvent.click(await screen.findByLabelText("a"));
    expect(screen.queryByLabelText(t("createIndexConcurrentlyToggle"))).toBeNull();
    expect(document.body.textContent).not.toContain("INDEX CONCURRENTLY");
  });

  it("CONCURRENTLY をオフにした PostgreSQL はロック待ちの上限つきの 1 トランザクション", async () => {
    stats.rows = 10;
    const onRun = open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    await waitFor(() => expect(screen.getByRole("button", { name: t("createIndexRun") })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: t("createIndexRun") }));
    const [, options] = onRun.mock.calls[0];
    expect(options.plan.lockTimeoutSecs).toBe(5);
    expect(options.plan.steps[0].transactional).toBe(true);
  });

  it("MySQL (バッククォート) でもロック待ちの上限つきの計画で実行する", async () => {
    const onRun = open("mysql");
    fireEvent.click(await screen.findByLabelText("a"));
    await waitFor(() => expect(screen.getByRole("button", { name: t("createIndexRun") })).not.toBeDisabled());
    // MySQL は既定オフなので、先にオンにする。
    fireEvent.click(screen.getByRole("switch", { name: t("ddlLockTimeoutLabel") }));
    fireEvent.click(screen.getByRole("button", { name: t("createIndexRun") }));
    const [sql, options] = onRun.mock.calls[0];
    expect(sql).toContain("`idx_t_a`");
    expect(options.plan.lockTimeoutSecs).toBeGreaterThan(0);
    expect(options.plan.steps[0].subject).toBe("idx_t_a");
  });

  it("SQLite は従来どおり SQL だけで実行する", async () => {
    const onRun = open("sqlite");
    fireEvent.click(await screen.findByLabelText("a"));
    await waitFor(() => expect(screen.getByRole("button", { name: t("createIndexRun") })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: t("createIndexRun") }));
    expect(onRun).toHaveBeenCalledWith(expect.stringContaining("CREATE INDEX"));
    expect(onRun.mock.calls[0]).toHaveLength(1);
  });
});
