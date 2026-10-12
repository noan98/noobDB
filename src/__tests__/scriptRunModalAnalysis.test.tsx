import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, act, waitFor } from "./testUtils";
import { t } from "../i18n";
import type {
  ScriptAnalysis,
  ScriptAnalyzedEvent,
  ScriptErrorEvent,
  ScriptStreamHandlers,
} from "../api/tauri";

// CI の 5 秒枠 (並列負荷でも落ちないよう、panelRowMemo.test.tsx と同じく余裕を持たせる)。
vi.setConfig({ testTimeout: 15_000 });

// ScriptRunModal (#1535): 実行ボタンでの自動事前確認・危険文の確認・expectedFile の送信・
// トランザクション中の失敗での再開の出し分け・ファイル変更エラーの扱い。

const handlers = new Map<string, ScriptStreamHandlers>();
let analyzeEvent: (streamId: string) => ScriptAnalyzedEvent;
let runBehavior: (streamId: string, options: unknown) => Promise<void> | void;
const analyzeSqlScript = vi.fn();
const runSqlScript = vi.fn();
const cancelStream = vi.fn().mockResolvedValue({ deliveredRows: 0 });

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      analyzeSqlScript: (a: { streamId: string }) => {
        analyzeSqlScript(a);
        queueMicrotask(() => handlers.get(a.streamId)?.onAnalyzed?.(analyzeEvent(a.streamId)));
        return Promise.resolve();
      },
      runSqlScript: (a: { streamId: string; options: unknown }) => {
        runSqlScript(a);
        return Promise.resolve(runBehavior(a.streamId, a.options));
      },
      cancelStream: (...a: unknown[]) => cancelStream(...a),
    },
    listenScriptStream: (id: string, h: ScriptStreamHandlers) => {
      handlers.set(id, h);
      return Promise.resolve(() => handlers.delete(id));
    },
  };
});

import { ScriptRunModal } from "../components/ScriptRunModal";

const STAMP = { size: 120, mtimeMs: 1_700_000_000_000 };

function analysis(over: Partial<ScriptAnalysis> = {}): ScriptAnalysis {
  return {
    totalStatements: 3,
    categories: { read: 0, write: 3, ddl: 0, txControl: 0 },
    dangerCounts: { deleteNoWhere: 0, updateNoWhere: 0, drop: 0, truncate: 0 },
    dangerousTotal: 0,
    blockedTotal: 0,
    txControlTotal: 0,
    head: [],
    dangerous: [],
    txControls: [],
    headLimit: 300,
    listLimit: 200,
    ...over,
  };
}

function analyzed(a: ScriptAnalysis, streamId = "x"): ScriptAnalyzedEvent {
  return { streamId, encoding: "utf-8", totalBytes: STAMP.size, fileStamp: STAMP, elapsedMs: 1, analysis: a };
}

function errorEvent(over: Partial<ScriptErrorEvent>): ScriptErrorEvent {
  return {
    streamId: "x",
    error: "line 4: boom",
    failure: { index: 4, line: 4, sql: "INSERT INTO nope VALUES (1)", error: "boom" },
    executed: 3,
    rolledBack: false,
    inTransaction: false,
    txBeginStatement: null,
    ...over,
  };
}

function setup() {
  renderWithProviders(<ScriptRunModal sessionId="s1" database={null} isProduction={false} onClose={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText(t("scriptFilePlaceholder")), {
    target: { value: "/tmp/a.sql" },
  });
}

beforeEach(() => {
  handlers.clear();
  analyzeSqlScript.mockClear();
  runSqlScript.mockClear();
  analyzeEvent = () => analyzed(analysis());
  runBehavior = (id) => {
    handlers.get(id)?.onDone?.({
      streamId: id,
      executed: 3,
      succeeded: 3,
      failedCount: 0,
      failures: [],
      skippedControl: 0,
      skippedExcluded: 0,
      skippedBeforeStart: 0,
      rowsAffected: 0,
      elapsedMs: 1,
    });
  };
});

describe("ScriptRunModal: 自動事前確認 (#1535)", () => {
  it("事前確認をしていなくても、実行ボタンで自動的に確認してから実行し、ファイルの印を渡す", async () => {
    setup();
    fireEvent.click(screen.getByText(t("scriptExecute")));
    await waitFor(() => expect(runSqlScript).toHaveBeenCalledTimes(1));
    expect(analyzeSqlScript).toHaveBeenCalledTimes(1);
    expect(runSqlScript.mock.calls[0][0].options.expectedFile).toEqual(STAMP);
  });

  it("自動の事前確認で危険文が見つかれば、確認を出し、承認するまで実行しない", async () => {
    analyzeEvent = () =>
      analyzed(
        analysis({
          dangerousTotal: 1,
          dangerCounts: { deleteNoWhere: 1, updateNoWhere: 0, drop: 0, truncate: 0 },
          dangerous: [
            { index: 2, line: 2, sql: "DELETE FROM t", category: "write", danger: "deleteNoWhere", blocked: false },
          ],
        }),
      );
    setup();
    fireEvent.click(screen.getByText(t("scriptExecute")));
    const confirmButton = await screen.findByText(t("scriptDangerConfirmOk"), {}, { timeout: 3000 });
    expect(runSqlScript).not.toHaveBeenCalled();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(runSqlScript).toHaveBeenCalledTimes(1));
  });
});

describe("ScriptRunModal: 失敗時の再開 (#1535)", () => {
  it("トランザクション中の失敗は ROLLBACK 失敗でも『この文から再開』を出さず、BEGIN から再開できる", async () => {
    runBehavior = (id) => {
      handlers.get(id)?.onError?.(errorEvent({ inTransaction: true, rolledBack: false, txBeginStatement: 2 }));
    };
    setup();
    fireEvent.click(screen.getByText(t("scriptExecute")));
    expect(await screen.findByText(t("scriptResumeFromBegin", { index: 2 }), {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText(t("scriptResume"))).toBeNull();
    expect(screen.queryByText(t("scriptResumeSkip"))).toBeNull();
  });

  it("トランザクション外の失敗は『この文から再開』『飛ばして再開』を出す", async () => {
    runBehavior = (id) => {
      handlers.get(id)?.onError?.(errorEvent({}));
    };
    setup();
    fireEvent.click(screen.getByText(t("scriptExecute")));
    expect(await screen.findByText(t("scriptResume"), {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(t("scriptResumeSkip"))).toBeTruthy();
  });

  it("BEGIN から再開すると開始文番号がその BEGIN になる", async () => {
    runBehavior = (id) => {
      handlers.get(id)?.onError?.(errorEvent({ inTransaction: true, txBeginStatement: 2 }));
    };
    setup();
    fireEvent.click(screen.getByText(t("scriptExecute")));
    const resume = await screen.findByText(t("scriptResumeFromBegin", { index: 2 }), {}, { timeout: 3000 });
    runSqlScript.mockClear();
    await act(async () => {
      fireEvent.click(resume);
    });
    await waitFor(() => expect(runSqlScript).toHaveBeenCalled());
    expect(runSqlScript.mock.calls[0][0].options.startAtStatement).toBe(2);
  });
});

describe("ScriptRunModal: 事前確認後のファイル変更 (#1535)", () => {
  it("バックエンドが『ファイルが変わった』と拒否したら、再確認を促す文言を出す", async () => {
    runBehavior = () =>
      Promise.reject(
        new Error(
          "[script-file-changed] the script file changed after the dry run, so statement numbers may no longer match; run the dry run again",
        ),
      );
    setup();
    fireEvent.change(screen.getByLabelText(t("scriptStartAtLabel")), { target: { value: "3" } });
    fireEvent.click(screen.getByText(t("scriptExecute")));
    expect((await screen.findAllByText(t("scriptAnalysisFileChanged"), {}, { timeout: 3000 })).length).toBeGreaterThan(0);
    // 開始文番号は残す (自動では再実行しない)。
    expect((screen.getByLabelText(t("scriptStartAtLabel")) as HTMLInputElement).value).toBe("3");
  });
});

describe("ScriptRunModal: 開始文番号がトランザクションの途中 (#1535)", () => {
  it("事前確認のあとで BEGIN〜COMMIT の途中の番号を入れると警告を出す", async () => {
    analyzeEvent = () =>
      analyzed(
        analysis({
          txControlTotal: 2,
          txControls: [
            { index: 2, line: 2, kind: "begin" },
            { index: 6, line: 6, kind: "commit" },
          ],
        }),
      );
    setup();
    fireEvent.click(screen.getByText(t("scriptAnalyze")));
    await screen.findByText(t("scriptAnalysisTxLocked"), {}, { timeout: 3000 });
    fireEvent.change(screen.getByLabelText(t("scriptStartAtLabel")), { target: { value: "4" } });
    expect(await screen.findByText(t("scriptStartInTransactionWarning", { start: 4, begin: 2 }), {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t("scriptStartAtLabel")), { target: { value: "7" } });
    await waitFor(() =>
      expect(screen.queryByText(t("scriptStartInTransactionWarning", { start: 7, begin: 2 }))).toBeNull(),
    );
  });

  it("トランザクション制御文のチェックボックスは無効で、通常の文は有効", async () => {
    analyzeEvent = () =>
      analyzed(
        analysis({
          txControlTotal: 1,
          txControls: [{ index: 1, line: 1, kind: "begin" }],
          head: [
            { index: 1, line: 1, sql: "BEGIN", category: "txControl", blocked: false },
            { index: 2, line: 2, sql: "INSERT INTO t VALUES (1)", category: "write", blocked: false },
          ],
        }),
      );
    setup();
    fireEvent.click(screen.getByText(t("scriptAnalyze")));
    const tx = await screen.findByLabelText(t("scriptAnalysisSkipAria", { index: 1 }), {}, { timeout: 3000 });
    expect((tx as HTMLInputElement).disabled).toBe(true);
    const stmt = screen.getByLabelText(t("scriptAnalysisSkipAria", { index: 2 }));
    expect((stmt as HTMLInputElement).disabled).toBe(false);
  });
});
