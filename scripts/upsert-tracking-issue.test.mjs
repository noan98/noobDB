// scripts/upsert-tracking-issue.sh (#1395) の自動テスト (#1633)。
// 実 GitHub では mutants / js-mutants の通知経路を検証できないため、`gh` を偽物の
// スクリプトに差し替えた PATH で bash を起動し、problem (新規作成 / 既存へのコメント /
// dedup キー一致で省略) と ok (close / 何もしない) の各分岐が呼ぶ gh サブコマンドを固定する。
// 実行: `pnpm run test:scripts` (Node 標準の `node:test` のみ・依存ゼロ)。
// Windows には bash 前提のスクリプトのため、Windows ランナーでは走らせない。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "upsert-tracking-issue.sh");

// 偽 gh: 呼び出しを 1 行 1 回で FAKE_LOG に記録し (引数は US 区切り)、読み取り系だけ
// 環境変数の固定応答を返す。--body-file の中身は FAKE_BODY_DIR に退避して後で検証する。
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "issue list") printf '%s' "\${FAKE_EXISTING:-}" ;;
  "issue view") printf '%s\\n' "\${FAKE_ISSUE_BODY:-}" ;;
  "issue comment"|"issue create")
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--body-file" ]; then cat "$a" >> "$FAKE_BODY_LOG"; echo "=====" >> "$FAKE_BODY_LOG"; fi
      prev="$a"
    done ;;
esac
if [ "$1" = "api" ]; then printf '%s\\n' "\${FAKE_COMMENTS:-}"; fi
if [ -n "\${FAKE_FAIL_ON:-}" ] && [ "$1 $2" = "$FAKE_FAIL_ON" ]; then exit 1; fi
exit 0
`;

function run(env, { withBody = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "upsert-test-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
    const log = join(dir, "gh.log");
    const bodyLog = join(dir, "body.log");
    const bodyFile = join(dir, "body.md");
    writeFileSync(log, "");
    writeFileSync(bodyLog, "");
    writeFileSync(bodyFile, "本文の要約\n");
    const r = spawnSync("bash", [SCRIPT], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        GITHUB_REPOSITORY: "o/r",
        TRACK_LABEL: "ci:test",
        FAKE_LOG: log,
        FAKE_BODY_LOG: bodyLog,
        ...(withBody ? { TRACK_BODY_FILE: bodyFile } : {}),
        ...env,
      },
      encoding: "utf8",
    });
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
      bodies: readFileSync(bodyLog, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const writes = (calls) =>
  calls.filter((c) => /^(issue (create|comment|close)|label create)/.test(c));

describe("upsert-tracking-issue.sh: problem", () => {
  it("open Issue が無ければラベルを作って新規作成する", () => {
    const r = run({
      TRACK_STATE: "problem",
      TRACK_TITLE: "検出されました",
      TRACK_EXTRA_LABELS: "cost:Mid,benefit:4",
    });
    assert.equal(r.status, 0, r.stderr);
    const w = writes(r.calls);
    assert.equal(w.filter((c) => c.startsWith("label create")).length, 3);
    assert.ok(w.some((c) => c.startsWith("label create ci:test") && c.includes("--color 5319e7")));
    assert.ok(w.some((c) => c.startsWith("label create cost:Mid") && c.includes("--color ededed")));
    const create = w.find((c) => c.startsWith("issue create"));
    assert.ok(create, "issue create が呼ばれる");
    assert.match(create, /--title 検出されました/);
    for (const l of ["ci:test", "cost:Mid", "benefit:4"]) {
      assert.ok(create.includes(`--label ${l}`), `${l} が付く`);
    }
    assert.ok(!w.some((c) => c.startsWith("issue comment")));
    assert.match(r.bodies, /本文の要約/);
    assert.match(r.bodies, /検出日時: .* JST/);
  });

  it("ラベル作成が失敗しても Issue は作成される (既存ラベル)", () => {
    const r = run({ TRACK_STATE: "problem", TRACK_TITLE: "t", FAKE_FAIL_ON: "label create" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.some((c) => c.startsWith("issue create")));
  });

  it("open Issue があればコメント追記し、新規作成はしない", () => {
    const r = run({ TRACK_STATE: "problem", TRACK_TITLE: "t", FAKE_EXISTING: "42" });
    assert.equal(r.status, 0, r.stderr);
    const w = writes(r.calls);
    assert.equal(w.length, 1);
    assert.match(w[0], /^issue comment 42 /);
    assert.ok(!r.calls.some((c) => c.startsWith("issue create")));
  });

  it("dedup キーが前回通知 (コメント) と同じならコメントを省略する", () => {
    const r = run({
      TRACK_STATE: "problem",
      TRACK_TITLE: "t",
      TRACK_DEDUP_KEY: "surv=3",
      FAKE_EXISTING: "42",
      FAKE_ISSUE_BODY: "<!-- tracking-key: surv=9 -->",
      FAKE_COMMENTS: "<!-- tracking-key: surv=3 -->",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(writes(r.calls), []);
    assert.match(r.stdout, /省略/);
  });

  it("dedup キーが本文だけに有り同じなら省略する (コメント無し)", () => {
    const r = run({
      TRACK_STATE: "problem",
      TRACK_TITLE: "t",
      TRACK_DEDUP_KEY: "surv=3",
      FAKE_EXISTING: "42",
      FAKE_ISSUE_BODY: "x\n<!-- tracking-key: surv=3 -->",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(writes(r.calls), []);
  });

  it("dedup キーが前回と違えばコメントし、本文にキーを埋め込む", () => {
    const r = run({
      TRACK_STATE: "problem",
      TRACK_TITLE: "t",
      TRACK_DEDUP_KEY: "surv=4",
      FAKE_EXISTING: "42",
      FAKE_COMMENTS: "<!-- tracking-key: surv=3 -->",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(writes(r.calls).length, 1);
    assert.match(r.bodies, /<!-- tracking-key: surv=4 -->/);
  });

  it("最新コメントのキーだけを比較する (古いキーに戻った場合は通知する)", () => {
    const r = run({
      TRACK_STATE: "problem",
      TRACK_TITLE: "t",
      TRACK_DEDUP_KEY: "surv=3",
      FAKE_EXISTING: "42",
      FAKE_COMMENTS: "<!-- tracking-key: surv=3 -->\n<!-- tracking-key: surv=4 -->",
    });
    assert.equal(writes(r.calls).length, 1);
  });

  it("DRY_RUN=1 では gh の書き込みを呼ばない", () => {
    const r = run({ TRACK_STATE: "problem", TRACK_TITLE: "t", DRY_RUN: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(writes(r.calls), []);
    assert.match(r.stdout, /\[dry-run\] gh issue create/);
  });

  it("TRACK_TITLE / TRACK_BODY_FILE が無ければ失敗する", () => {
    assert.notEqual(run({ TRACK_STATE: "problem" }).status, 0);
    assert.notEqual(run({ TRACK_STATE: "problem", TRACK_TITLE: "t" }, { withBody: false }).status, 0);
  });
});

describe("upsert-tracking-issue.sh: ok", () => {
  it("open Issue があれば回復コメントして close する", () => {
    const r = run({ TRACK_STATE: "ok", FAKE_EXISTING: "42" });
    assert.equal(r.status, 0, r.stderr);
    const w = writes(r.calls);
    assert.equal(w.length, 2);
    assert.match(w[0], /^issue comment 42 /);
    assert.match(w[1], /^issue close 42 .*--reason completed/);
    assert.match(r.bodies, /回復を確認しました/);
  });

  it("open Issue が無ければ何もしない", () => {
    const r = run({ TRACK_STATE: "ok" });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(writes(r.calls), []);
  });
});

describe("upsert-tracking-issue.sh: 入力検証", () => {
  it("不正な TRACK_STATE は exit 2", () => {
    assert.equal(run({ TRACK_STATE: "bogus" }).status, 2);
  });
  it("TRACK_LABEL / TRACK_STATE が無ければ失敗する", () => {
    assert.notEqual(run({ TRACK_LABEL: "", TRACK_STATE: "ok" }).status, 0);
    assert.notEqual(run({}).status, 0);
  });
});
