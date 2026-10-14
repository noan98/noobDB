import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { act, fireEvent, renderWithProviders, screen } from "./testUtils";
import { __resetActivityLog, getActivityState } from "../activityLog";
import {
  __resetIpcDiagnostics,
  buildIpcDiagnosticText,
  IPC_FAILURE_DEDUPE_MS,
  recordIpcValidationFailure,
} from "../api/ipcDiagnostics";
import { parseResponse } from "../api/schemas";
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
