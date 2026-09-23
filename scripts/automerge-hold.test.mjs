// automerge の変更依頼ゲート (#1108) のユニットテスト。
// GitHub Actions の実環境ではこの判定を動かして確かめられないため、PR #1101 の
// 取りこぼしと境界ケースをここで固定する。実行: `pnpm run test:scripts`
// (Node 標準の `node:test` のみ・依存ゼロ)。CI では `ci.yml` の
// `automerge gate (script tests)` ジョブが走らせる。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  detectChangeRequest,
  evaluateHold,
  isBot,
  parseHoldCommand,
  stripNonDirectiveText,
} from "./automerge-hold.mjs";

const OWNER = { login: "noan98", type: "User" };
const BEFORE_PUSH = "2026-09-08T03:00:00Z";
const PUSH = "2026-09-08T04:00:00Z";
const AFTER_PUSH = "2026-09-08T05:00:00Z";

function comment(body, { at = BEFORE_PUSH, updatedAt, user = OWNER, assoc = "OWNER" } = {}) {
  return {
    user,
    author_association: assoc,
    body,
    created_at: at,
    updated_at: updatedAt ?? at,
    html_url: "https://example.invalid/c",
  };
}

function review(state, body = "", { at = BEFORE_PUSH, user = OWNER, assoc = "OWNER" } = {}) {
  return { user, author_association: assoc, state, body, submitted_at: at, html_url: "https://example.invalid/r" };
}

const hold = (input) => evaluateHold({ pushObservedAt: PUSH, ...input }).hold;

describe("レビューが付かない PR (受け入れ条件 3: 従来どおり通過)", () => {
  it("コメントもレビューもラベルも無ければ保留しない", () => {
    assert.deepEqual(evaluateHold({ pushObservedAt: PUSH }), { hold: false, reasons: [] });
  });
  it("入力が空・欠けていても落ちずに通過", () => {
    assert.equal(evaluateHold({}).hold, false);
    assert.equal(evaluateHold(undefined).hold, false);
  });
  it("変更依頼ではない通常コメント・承認・COMMENTED レビューは保留しない", () => {
    // push 観測時刻を渡さない (= push による解除が効かない) 状態でも通ること。
    const r = evaluateHold({
      comments: [comment("LGTM です。ありがとう"), comment("CI 待ちです"), comment("merge したら教えて")],
      reviews: [review("APPROVED", "良さそう"), review("COMMENTED", "nit: 変数名")],
    });
    assert.deepEqual(r, { hold: false, reasons: [] });
  });
  it("他の保留とは無関係なラベルは無視", () => {
    assert.equal(hold({ labels: ["bug", "automerge-without-codex", "cost:Mid"] }), false);
  });
});

describe("PR #1101 の再現: 通常コメントでの変更依頼", () => {
  it("OWNER の「この点を修正してから merge 推奨」で保留する", () => {
    const r = evaluateHold({
      pushObservedAt: PUSH,
      comments: [comment("競合バグがあります。\nこの点を修正してから merge 推奨です。", { at: AFTER_PUSH })],
    });
    assert.equal(r.hold, true);
    assert.match(r.reasons[0], /修正してから merge/);
  });
  it("MEMBER / COLLABORATOR の依頼でも保留する", () => {
    assert.equal(hold({ comments: [comment("do not merge yet", { assoc: "MEMBER", at: AFTER_PUSH })] }), true);
    assert.equal(hold({ comments: [comment("マージは保留で", { assoc: "COLLABORATOR", at: AFTER_PUSH })] }), true);
  });
  it("依頼より後に head が push されたら解除 (修正 push で意図が満たされる)", () => {
    assert.equal(
      hold({ comments: [comment("修正してからマージしてください", { at: BEFORE_PUSH })] }),
      false,
    );
  });
  it("push より後の依頼は保留のまま", () => {
    assert.equal(hold({ comments: [comment("修正してからマージしてください", { at: AFTER_PUSH })] }), true);
  });
  it("依頼と push 観測が同時刻なら安全側で保留", () => {
    assert.equal(hold({ comments: [comment("do not merge", { at: PUSH })] }), true);
  });
  it("push 観測時刻が不明なら push では解除できない (安全側)", () => {
    assert.equal(
      evaluateHold({ pushObservedAt: "", comments: [comment("do not merge", { at: BEFORE_PUSH })] }).hold,
      true,
    );
  });
  it("push 前のコメントを push 後に編集して依頼を足した場合は保留", () => {
    assert.equal(
      hold({ comments: [comment("修正してから merge で", { at: BEFORE_PUSH, updatedAt: AFTER_PUSH })] }),
      true,
    );
  });
  it("レビュー本文 (COMMENTED, スレッド無し) の依頼でも保留する", () => {
    assert.equal(hold({ reviews: [review("COMMENTED", "fix the race before merging", { at: AFTER_PUSH })] }), true);
  });
});

describe("投稿者のフィルタ", () => {
  it("OWNER / MEMBER / COLLABORATOR 以外 (CONTRIBUTOR / NONE / FIRST_TIMER) の依頼は無視", () => {
    for (const assoc of ["CONTRIBUTOR", "NONE", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", null]) {
      assert.equal(hold({ comments: [comment("/hold", { assoc, at: AFTER_PUSH })] }), false, String(assoc));
      assert.equal(hold({ comments: [comment("do not merge", { assoc, at: AFTER_PUSH })] }), false, String(assoc));
    }
  });
  it("bot の投稿は association に関係なく無視 (Codex / github-actions)", () => {
    const codex = { login: "chatgpt-codex-connector[bot]", type: "Bot" };
    const actions = { login: "github-actions[bot]", type: "Bot" };
    assert.equal(hold({ comments: [comment("do not merge", { user: codex, assoc: "NONE", at: AFTER_PUSH })] }), false);
    assert.equal(hold({ comments: [comment("/hold", { user: actions, assoc: "OWNER", at: AFTER_PUSH })] }), false);
    assert.equal(hold({ reviews: [review("CHANGES_REQUESTED", "", { user: codex, assoc: "OWNER" })] }), false);
  });
  it("type が User でも login が [bot] で終われば bot 扱い / 投稿者不明は信頼しない", () => {
    assert.equal(isBot({ login: "renovate[bot]", type: "User" }), true);
    assert.equal(isBot(null), true);
    assert.equal(isBot({ login: "botman", type: "User" }), false);
  });
  it("automerge 自身のマーカー付きコメントは無視", () => {
    const body = "@codex review\n\n<!-- automerge:codex-review-request:abc -->\ndo not merge";
    assert.equal(hold({ comments: [comment(body, { at: AFTER_PUSH })] }), false);
  });
});

describe("/hold と /unhold", () => {
  it("/hold 行で保留し、push では解除されない", () => {
    assert.equal(hold({ comments: [comment("/hold", { at: BEFORE_PUSH })] }), true);
  });
  it("大文字・前後空白を許容", () => {
    assert.equal(parseHoldCommand("  /HOLD  "), "hold");
    assert.equal(parseHoldCommand("/Hold Cancel"), "unhold");
  });
  it("後の /unhold で解除 (時系列で判定)", () => {
    assert.equal(
      hold({ comments: [comment("/hold", { at: BEFORE_PUSH }), comment("/unhold", { at: AFTER_PUSH })] }),
      false,
    );
  });
  it("配列の順序ではなく時刻順で畳み込む", () => {
    assert.equal(
      hold({ comments: [comment("/hold", { at: AFTER_PUSH }), comment("/unhold", { at: BEFORE_PUSH })] }),
      true,
    );
  });
  it("/unhold は定型句の保留も解除する", () => {
    assert.equal(
      hold({ comments: [comment("do not merge", { at: AFTER_PUSH }), comment("/unhold", { at: "2026-09-08T06:00:00Z" })] }),
      false,
    );
  });
  it("/unhold コメント中の定型句は数えない", () => {
    assert.equal(hold({ comments: [comment("/unhold\ndo not merge の件は解決済み", { at: AFTER_PUSH })] }), false);
  });
  it("信頼できないユーザの /unhold では解除できない", () => {
    assert.equal(
      hold({
        comments: [
          comment("/hold", { at: BEFORE_PUSH }),
          comment("/unhold", { at: AFTER_PUSH, user: { login: "stranger", type: "User" }, assoc: "NONE" }),
        ],
      }),
      true,
    );
  });
  it("時刻不明の /unhold は保留を消さない", () => {
    assert.equal(
      hold({ comments: [comment("/hold", { at: BEFORE_PUSH }), comment("/unhold", { at: "", updatedAt: "" })] }),
      true,
    );
  });
  it("文中の /hold (説明文) はコマンドとして数えない", () => {
    assert.equal(parseHoldCommand("止めたいときは /hold と書いてください"), null);
    assert.equal(hold({ comments: [comment("止めたいときは /hold と書いてください", { at: AFTER_PUSH })] }), false);
  });
  it("レビュー本文の /hold でも保留する", () => {
    assert.equal(hold({ reviews: [review("COMMENTED", "/hold", { at: BEFORE_PUSH })] }), true);
  });
  it("未提出 (PENDING) のレビューは無視", () => {
    assert.equal(hold({ reviews: [review("PENDING", "/hold", { at: AFTER_PUSH })] }), false);
  });
});

describe("CHANGES_REQUESTED レビュー", () => {
  it("本文だけの Request changes でも保留し、push では解除されない", () => {
    assert.equal(hold({ reviews: [review("CHANGES_REQUESTED", "", { at: BEFORE_PUSH })] }), true);
  });
  it("同じレビュアが後で APPROVED すれば解除", () => {
    assert.equal(
      hold({ reviews: [review("CHANGES_REQUESTED", "", { at: BEFORE_PUSH }), review("APPROVED", "", { at: AFTER_PUSH })] }),
      false,
    );
  });
  it("dismiss 済み (DISMISSED) なら解除", () => {
    assert.equal(hold({ reviews: [review("DISMISSED", "", { at: BEFORE_PUSH })] }), false);
  });
  it("後の COMMENTED レビューでは解除されない (GitHub のレビュー状態と同じ)", () => {
    assert.equal(
      hold({ reviews: [review("CHANGES_REQUESTED", "", { at: BEFORE_PUSH }), review("COMMENTED", "ok", { at: AFTER_PUSH })] }),
      true,
    );
  });
  it("別のレビュアの APPROVED では解除されない", () => {
    const other = { login: "alice", type: "User" };
    assert.equal(
      hold({
        reviews: [
          review("CHANGES_REQUESTED", "", { at: BEFORE_PUSH }),
          review("APPROVED", "", { at: AFTER_PUSH, user: other, assoc: "MEMBER" }),
        ],
      }),
      true,
    );
  });
  it("信頼できないユーザの Request changes は無視", () => {
    const stranger = { login: "stranger", type: "User" };
    assert.equal(hold({ reviews: [review("CHANGES_REQUESTED", "", { user: stranger, assoc: "NONE" })] }), false);
  });
});

describe("保留ラベル", () => {
  it("既定の do-not-merge ラベルで保留", () => {
    assert.equal(hold({ labels: ["do-not-merge"] }), true);
  });
  it("holdLabel で名前を差し替えられる", () => {
    assert.equal(hold({ labels: ["wip"], holdLabel: "wip" }), true);
    assert.equal(hold({ labels: ["do-not-merge"], holdLabel: "wip" }), false);
  });
});

describe("定型句の検出", () => {
  const shouldHold = [
    "この点を修正してから merge 推奨",
    "修正してからマージしてください",
    "対応してから merge でお願いします",
    "直してからマージで",
    "merge 前に修正が必要です",
    "マージする前に対応してください",
    "マージは保留でお願いします",
    "まだ merge しないでください",
    "マージ待ってください",
    "この状態ではマージ不可です",
    "Do not merge until the race is fixed",
    "DON'T MERGE",
    "don’t merge this yet",
    "do-not-merge",
    "Please fix the race condition before merging.",
    "address this before merge",
    "Not ready to merge",
    "please hold off on merging",
  ];
  for (const body of shouldHold) {
    it(`検出する: ${body}`, () => assert.notEqual(detectChangeRequest(body), null));
  }

  const shouldPass = [
    "LGTM",
    "マージしました",
    "merge conflict を解消しました",
    "main を merge して最新化しました",
    "修正しました。ご確認ください",
    "before merging main into this branch I rebased", // "before merging" だけでは検出しない
    "Fixed in abc123",
    "automerge が止まっていたので再実行します",
  ];
  for (const body of shouldPass) {
    it(`検出しない: ${body}`, () => assert.equal(detectChangeRequest(body), null));
  }

  it("コードブロック・インラインコード・引用・HTML コメント内は無視", () => {
    assert.equal(detectChangeRequest("```\ndo not merge\n```"), null);
    assert.equal(detectChangeRequest("~~~sh\n# do not merge\n~~~\nOK"), null);
    assert.equal(detectChangeRequest("`do not merge` というラベルがあります"), null);
    assert.equal(detectChangeRequest("> 修正してから merge 推奨\n対応しました"), null);
    assert.equal(detectChangeRequest("<!-- do not merge -->LGTM"), null);
    assert.equal(parseHoldCommand("```\n/hold\n```"), null);
    assert.equal(parseHoldCommand("> /hold"), null);
  });
  it("閉じていないコードブロックは末尾までコード扱い", () => {
    assert.equal(stripNonDirectiveText("OK\n```\ndo not merge").includes("do not merge"), false);
  });
  it("入れ子・閉じていない HTML コメントも除去しきる (CodeQL 指摘の回帰)", () => {
    const nested = stripNonDirectiveText("<!<!-- x -->-- do not merge -->ok");
    assert.equal(nested.includes("<!--"), false);
    assert.equal(stripNonDirectiveText("LGTM <!-- do not merge"), "LGTM ");
    assert.equal(detectChangeRequest("LGTM <!-- do not merge"), null);
  });
  it("コードブロックの後の本文は検出対象", () => {
    assert.notEqual(detectChangeRequest("```\nx\n```\ndo not merge"), null);
  });
  it("CRLF 改行でも行単位のコマンドを読める", () => {
    assert.equal(parseHoldCommand("理由あり\r\n/hold\r\n"), "hold");
  });
});

describe("CLI (ワークフローからの呼び出し口)", () => {
  const script = fileURLToPath(new URL("./automerge-hold.mjs", import.meta.url));
  it("標準入力の JSON を評価して JSON を返す", () => {
    const input = JSON.stringify({ pushObservedAt: PUSH, labels: ["do-not-merge"] });
    const res = spawnSync(process.execPath, [script], { input, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).hold, true);
  });
  it("壊れた JSON は exit 2 (ワークフローは set -e で止まる = マージしない)", () => {
    const res = spawnSync(process.execPath, [script], { input: "{", encoding: "utf8" });
    assert.equal(res.status, 2);
  });
});
