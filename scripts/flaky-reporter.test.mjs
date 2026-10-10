// flaky-reporter.mjs (#1396) のユニットテスト。実行: `pnpm run test:scripts`
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import FlakyReporter, { pickFlaky, renderAnnotation, renderSummary } from "./flaky-reporter.mjs";

const r = (over) => ({ name: "t", file: "a.browser.test.tsx", state: "passed", retryCount: 0, ...over });

describe("pickFlaky", () => {
  it("retry で合格したものだけ拾う", () => {
    const out = pickFlaky([
      r({ name: "clean" }),
      r({ name: "flaky", retryCount: 1 }),
      r({ name: "failed-after-retry", state: "failed", retryCount: 1 }),
      r({ name: "skipped", state: "skipped" }),
    ]);
    assert.deepEqual(out.map((x) => x.name), ["flaky"]);
  });
});

describe("renderSummary", () => {
  it("揺らぎが無ければ空文字", () => {
    assert.equal(renderSummary([]), "");
  });
  it("表を出し、セルの | と改行をエスケープする", () => {
    const md = renderSummary([r({ name: "a|b\nc", retryCount: 1 })]);
    assert.match(md, /1 件が再試行/);
    assert.match(md, /\| a\.browser\.test\.tsx \| a\\\|b c \| 1 \|/);
  });
});

describe("renderAnnotation", () => {
  it("警告コマンドをエスケープして出す", () => {
    assert.equal(
      renderAnnotation(r({ name: "100%\nx", file: "a,b.tsx", retryCount: 2 })),
      "::warning file=a%2Cb.tsx::flaky: 100%25%0Ax (retry x2)",
    );
  });
});

describe("FlakyReporter", () => {
  it("diagnostic の retryCount を集めて onTestRunEnd で出力する", () => {
    const rep = new FlakyReporter();
    const tc = (retryCount) => ({
      fullName: "suite t",
      module: { relativeModuleId: "src/x.browser.test.tsx" },
      diagnostic: () => ({ retryCount }),
      result: () => ({ state: "passed" }),
    });
    rep.onTestCaseResult(tc(0));
    rep.onTestCaseResult(tc(1));
    assert.equal(pickFlaky(rep.results).length, 1);
  });
});
