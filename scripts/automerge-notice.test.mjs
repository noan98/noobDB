// automerge の通知コメント (#1632) のユニットテスト。実行: `pnpm run test:scripts`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { AUTOMERGE_MARKER, evaluateHold } from "./automerge-hold.mjs";
import { buildBody, findNotice, NOTICE_MARKER, planNotice } from "./automerge-notice.mjs";

const BOT = { login: "github-actions[bot]", type: "Bot" };
const OWNER = { login: "noan98", type: "User" };
const failed = (extra = {}) => ({ kind: "merge_failed", headSha: "abc", mergeStateStatus: "BLOCKED", ...extra });

describe("マーカー", () => {
  it("AUTOMERGE_MARKER で始まる (issue_comment トリガの除外条件と整合)", () => {
    assert.ok(NOTICE_MARKER.startsWith(AUTOMERGE_MARKER));
    for (const kind of ["hold_fail", "merge_failed", "resolved"]) {
      assert.ok(buildBody({ kind }).includes(AUTOMERGE_MARKER));
    }
  });
  it("通知コメントは変更依頼ゲートの判定材料にならない (自己再帰しない)", () => {
    const comments = ["hold_fail", "merge_failed"].map((kind, i) => ({
      id: i,
      user: OWNER, // 仮に人間名義でも、マーカー入りは無視される
      author_association: "OWNER",
      created_at: "2026-10-14T00:00:00Z",
      body: buildBody({ kind, detail: "do not merge /hold" }),
    }));
    const r = evaluateHold({ labels: [], comments, reviews: [], pushObservedAt: "", holdLabel: "do-not-merge" });
    assert.equal(r.hold, false);
  });
});

describe("findNotice", () => {
  it("bot の投稿だけを対象にする", () => {
    assert.equal(findNotice([{ id: 1, user: OWNER, body: NOTICE_MARKER }]), null);
    assert.equal(findNotice([{ id: 2, user: BOT, body: NOTICE_MARKER }])?.id, 2);
  });
  it("マーカーの無い bot コメントは無視する / 空でも落ちない", () => {
    assert.equal(findNotice([{ id: 1, user: BOT, body: "ok" }]), null);
    assert.equal(findNotice([]), null);
    assert.equal(findNotice(undefined), null);
  });
});

describe("planNotice", () => {
  it("既存が無ければ作成", () => {
    const r = planNotice({ comments: [], ...failed() });
    assert.equal(r.action, "create");
    assert.match(r.body, /BLOCKED/);
  });
  it("既存があれば PR 単位で 1 件に保つため更新", () => {
    const comments = [{ id: 7, user: BOT, body: buildBody(failed({ mergeStateStatus: "UNKNOWN" })) }];
    const r = planNotice({ comments, ...failed() });
    assert.deepEqual([r.action, r.commentId], ["update", 7]);
  });
  it("同じ本文なら何もしない", () => {
    const comments = [{ id: 7, user: BOT, body: buildBody(failed()) }];
    assert.equal(planNotice({ comments, ...failed() }).action, "none");
  });
  it("hold_fail から merge_failed へも同じコメントを更新する", () => {
    const comments = [{ id: 3, user: BOT, body: buildBody({ kind: "hold_fail", detail: "x" }) }];
    assert.equal(planNotice({ comments, ...failed() }).commentId, 3);
  });
  it("マージ成功: 失敗の記録があれば解消に編集、無ければ何もしない", () => {
    const comments = [{ id: 7, user: BOT, body: buildBody(failed()) }];
    const r = planNotice({ comments, kind: "resolved" });
    assert.deepEqual([r.action, r.commentId], ["update", 7]);
    assert.match(r.body, /解消しました/);
    assert.equal(planNotice({ comments: [], kind: "resolved" }).action, "none");
  });
  it("解消済みを再度編集しない", () => {
    const comments = [{ id: 7, user: BOT, body: buildBody({ kind: "resolved" }) }];
    assert.equal(planNotice({ comments, kind: "resolved" }).action, "none");
  });
  it("解消後に再度失敗したら同じコメントを失敗内容に戻す", () => {
    const comments = [{ id: 7, user: BOT, body: buildBody({ kind: "resolved" }) }];
    assert.equal(planNotice({ comments, ...failed() }).action, "update");
  });
  it("未知の kind は例外", () => {
    assert.throws(() => planNotice({ comments: [], kind: "x" }));
  });
});

describe("CLI", () => {
  const script = fileURLToPath(new URL("./automerge-notice.mjs", import.meta.url));
  it("JSON を受けて計画を返す", () => {
    const r = spawnSync("node", [script], { input: JSON.stringify({ comments: [], ...failed() }), encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).action, "create");
  });
  it("壊れた入力は exit 2", () => {
    assert.equal(spawnSync("node", [script], { input: "{", encoding: "utf8" }).status, 2);
  });
});
