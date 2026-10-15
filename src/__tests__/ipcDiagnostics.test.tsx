import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { __resetActivityLog, getActivityState } from "../activityLog";
import {
  __resetIpcDiagnostics,
  buildIpcDiagnosticText,
  buildIpcMismatchDiagnosticText,
  dismissIpcMismatch,
  getIpcMismatchState,
  IPC_FAILURE_DEDUPE_MS,
  recordIpcValidationFailure,
} from "../api/ipcDiagnostics";
import { parseResponse } from "../api/schemas";
import { IpcMismatchNotice } from "../components/IpcMismatchNotice";
import { ActivityDetailView } from "../components/ActivityDetailView";
import { t } from "../i18n";

vi.mock("../updater", () => ({ getCurrentAppVersion: vi.fn().mockResolvedValue("1.2.3") }));

beforeEach(() => {
  __resetActivityLog();
  __resetIpcDiagnostics();
});

describe("parseResponse の検証失敗の記録 (#1536)", () => {
  it("成功時は何も記録しない", () => {
    parseResponse(z.object({ a: z.number() }), { a: 1 }, "ok_command");
    expect(getActivityState().entries).toHaveLength(0);
  });

  it("失敗時はコマンド名と失敗パスをアクティビティへ記録し、エラーも投げ続ける", () => {
    expect(() => parseResponse(z.object({ a: z.number() }), { a: "x" }, "list_things")).toThrow(
      /list_things/,
    );
    const [entry] = getActivityState().entries;
    expect(entry.severity).toBe("error");
    expect(entry.message).toContain("list_things");
    expect(entry.detail).toMatchObject({ kind: "ipcValidation", command: "list_things" });
    expect(entry.detail?.kind === "ipcValidation" && entry.detail.issues[0]).toMatch(/^a:/);
  });

  it("同じ失敗は一定時間内に再記録しない (ポーリングで一覧を埋めない)", () => {
    const now = 1_000_000;
    expect(recordIpcValidationFailure("cmd", ["a: bad"], now)).toBe(true);
    expect(recordIpcValidationFailure("cmd", ["a: bad"], now + 1000)).toBe(false);
    expect(recordIpcValidationFailure("cmd", ["b: bad"], now + 1000)).toBe(true);
    expect(recordIpcValidationFailure("cmd", ["a: bad"], now + IPC_FAILURE_DEDUPE_MS + 1)).toBe(true);
    expect(getActivityState().entries).toHaveLength(3);
  });
});

describe("診断テキスト", () => {
  it("コマンド名・失敗パス・バージョンを含み、行データは含まない", () => {
    const text = buildIpcDiagnosticText(
      { command: "list_things", issues: ["rows.0.id: Expected number"], at: 0 },
      "1.2.3",
    );
    expect(text).toContain("app version: 1.2.3");
    expect(text).toContain("command: list_things");
    expect(text).toContain("rows.0.id: Expected number");
    expect(text).toContain("1970-01-01T00:00:00.000Z");
    expect(buildIpcDiagnosticText({ command: "c", issues: [], at: 0 }, null)).toContain(
      "app version: unknown",
    );
  });
});

describe("ActivityDetailView: ipcValidation", () => {
  it("診断テキストを表示し、コピーできる", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderWithProviders(
      <ActivityDetailView
        detail={{ kind: "ipcValidation", command: "list_things", issues: ["a: bad"], at: 0 }}
      />,
    );
    await screen.findByText(/app version: 1\.2\.3/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("ipcValidationCopy") }));
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("command: list_things"));
  });
});

describe("版不一致の警告 (#1622)", () => {
  it("異なる 3 コマンドの検証失敗で 1 回だけ有効になり、同じコマンドの繰り返しでは有効にならない", () => {
    const now = 1_000_000;
    recordIpcValidationFailure("a", ["x: bad"], now);
    recordIpcValidationFailure("a", ["x: bad"], now + 1);
    recordIpcValidationFailure("b", ["y: bad"], now + 2);
    expect(getIpcMismatchState().active).toBe(false);
    recordIpcValidationFailure("c", ["z: bad"], now + 3);
    expect(getIpcMismatchState().active).toBe(true);
    expect(getIpcMismatchState().failures.map((f) => f.command)).toEqual(["a", "b", "c"]);
  });

  it("重複抑止で記録を捨てた失敗も、異なるコマンド数には数える", () => {
    const now = 1_000_000;
    // a は 5 分内の再失敗 (アクティビティには積まれない) でも追跡対象。
    recordIpcValidationFailure("a", ["x: bad"], now);
    recordIpcValidationFailure("a", ["x: bad"], now + 10);
    recordIpcValidationFailure("b", ["x: bad"], now + 20);
    recordIpcValidationFailure("c", ["x: bad"], now + 30);
    expect(getIpcMismatchState().active).toBe(true);
  });

  it("閉じたら同じセッションでは再表示しない", () => {
    for (const c of ["a", "b", "c"]) recordIpcValidationFailure(c, ["x: bad"], 1);
    expect(getIpcMismatchState().active).toBe(true);
    dismissIpcMismatch();
    expect(getIpcMismatchState().active).toBe(false);
    recordIpcValidationFailure("d", ["x: bad"], 2);
    recordIpcValidationFailure("e", ["x: bad"], 3);
    expect(getIpcMismatchState().active).toBe(false);
  });

  it("診断テキストは全コマンドの失敗パスとバージョンを含み、値は含まない", () => {
    const text = buildIpcMismatchDiagnosticText(
      [
        { command: "a", issues: ["rows.0.id: Expected number"], at: 0 },
        { command: "b", issues: ["name: Required"], at: 0 },
      ],
      "1.2.3",
    );
    expect(text).toContain("app version: 1.2.3");
    expect(text).toContain("failed commands: 2");
    expect(text).toContain("command: a");
    expect(text).toContain("name: Required");
  });

  it("Callout は警告を出し、診断テキストをコピーでき、閉じると消える", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderWithProviders(<IpcMismatchNotice />);
    expect(screen.queryByTestId("ipc-mismatch-notice")).toBeNull();
    act(() => {
      for (const c of ["a", "b", "c"]) recordIpcValidationFailure(c, ["x: bad"], 1);
    });
    const notice = await screen.findByTestId("ipc-mismatch-notice");
    expect(notice.textContent).toContain(t("ipcMismatchTitle"));
    fireEvent.click(screen.getByRole("button", { name: t("ipcMismatchCopy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("command: c")));
    fireEvent.click(screen.getByRole("button", { name: t("ipcMismatchDismiss") }));
    expect(screen.queryByTestId("ipc-mismatch-notice")).toBeNull();
  });
});
