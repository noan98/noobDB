// automerge の「変更依頼ゲート」(#1108) の判定ロジック。
//
// `.github/workflows/automerge.yml` の Step 4b から呼ばれ、PR に
// 「明示的に変更を求められている (= まだマージしてはいけない)」状態が残って
// いないかを判定する。判定材料は GitHub REST API の生オブジェクト
// (issue comment / pull review / ラベル名) と head の push 観測時刻だけで、
// ネットワークにも git にも触らない純関数として書いてある。これにより
// GitHub Actions の実環境を使わずに `node --test` で境界ケースを固定できる。
//
// ## なぜ必要か
//
// PR #1101 で、オーナーが「この点を修正してから merge 推奨」という変更依頼を
// **通常コメント (issue comment)** で投稿した直後に automerge がマージした。
// automerge の Step 6 は「未解決のレビュースレッド」しか見ておらず、通常コメントと
// 行に紐付かないレビュー本文はスレッドを作らないため、依頼を取りこぼした。
//
// ## 何を「マージ保留」と見なすか (強い順)
//
// 1. 保留ラベル (`do-not-merge`)。外すまで保留。
// 2. 信頼できる人間 (OWNER / MEMBER / COLLABORATOR) の **`/hold` コマンド行**
//    (コメント本文またはレビュー本文)。後から同じく信頼できる人間が `/unhold`
//    するまで保留し、**push では解除されない**。
// 3. 信頼できる人間の **`CHANGES_REQUESTED` レビュー** (レビュアごとの最新の
//    APPROVED / CHANGES_REQUESTED / DISMISSED が CHANGES_REQUESTED のもの)。
//    GitHub のレビュー状態と同じく、承認し直す / dismiss するまで保留する。
//    行コメントを付けずに本文だけで「Request changes」するとスレッドが
//    できないため、これも Step 6 では拾えなかった。
// 4. 信頼できる人間のコメント / レビュー本文に含まれる **変更依頼の定型句**
//    (「修正してから merge」「マージしないで」「do not merge」など、
//    `CHANGE_REQUEST_PATTERNS`)。これは **その後に head が push されたら解除**
//    する (依頼への対応 push で意図が満たされる前提)。新しい head には Codex の
//    再レビュー (Step 5) が改めて必要なので、push だけで無審査になるわけではない。
//    push で解除したくない強い保留は `/hold` を使う。`/unhold` でも解除できる。
//
// ## 意図的に無視するもの (誤検出で automerge を殺さないため)
//
// - bot の投稿 (`user.type == "Bot"` または login が `[bot]` で終わる)。
//   Codex の指摘はレビュースレッドとして Step 6 が拾い、`github-actions[bot]` の
//   自動投稿は判定材料ではない。
// - automerge 自身のマーカー (`<!-- automerge:`) を含む投稿。
// - OWNER / MEMBER / COLLABORATOR 以外の投稿。public リポジトリなので誰でも
//   コメントでき、それで任意の PR を止められると DoS になる。
// - コードブロック (``` / ~~~)・インラインコード・引用行 (`>`)・HTML コメントの中。
//   「`/hold` と書くと止まります」のような説明や、他人の発言の引用で止めない。
//
// 定型句の検出はキーワードマッチなので否定文 (「修正してから merge する必要は
// ない」) でも保留になる。これは「マージしない」側に倒れる誤検出であり、次の
// push か `/unhold` で解除できるので許容する (逆向きの取りこぼし = 既知バグの
// main 混入の方が被害が大きい)。

import { pathToFileURL } from "node:url";

/** 判定に使う `author_association` (リポジトリへの書き込み権限を持つ層)。 */
export const TRUSTED_ASSOCIATIONS = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);

/** automerge 自身が投稿するコメントのマーカー接頭辞。 */
export const AUTOMERGE_MARKER = "<!-- automerge:";

/** 既定の保留ラベル名。ワークフローの env `HOLD_LABEL` で上書きできる。 */
export const DEFAULT_HOLD_LABEL = "do-not-merge";

/**
 * 変更依頼の定型句。コード・引用を取り除いて小文字化した本文に対して照合する。
 * 追加するときは `automerge-hold.test.mjs` に「止まるべき文」と
 * 「止まってはいけない文」を必ず両方足すこと。
 */
export const CHANGE_REQUEST_PATTERNS = Object.freeze([
  // 修正してから merge / 対応してからマージ / 直してから merge (#1101 の文言)
  /(?:修正|対応|直)(?:して|し)から\s*(?:merge|マージ)/u,
  // merge 前に修正 / マージする前に対応
  /(?:merge|マージ)\s*(?:する)?\s*前に\s*(?:修正|対応|直)/u,
  // マージは保留 / merge しないで / マージ待って / マージ不可 / マージ禁止
  /(?:merge|マージ)\s*(?:は|を)?\s*(?:保留|待って|しないで|しないでください|止めて|とめて|不可|禁止)/u,
  // do not merge / don't merge / dont merge / do-not-merge
  /\bdo(?:\s+|-)not(?:\s+|-)merge\b/u,
  /\bdon['’]?t\s+merge\b/u,
  // fix X before merge / address this before merging
  /\b(?:fix|address|resolve)\b[^\n]{0,80}?\bbefore\s+merg(?:e|ing)\b/u,
  // not ready to merge / hold off on merging
  /\bnot\s+ready\s+(?:to|for)\s+merg(?:e|ing)\b/u,
  /\bhold\s+off\s+(?:on\s+)?merg(?:e|ing)\b/u,
]);

/** bot の投稿か。login の `[bot]` 接尾辞は一般ユーザが作れない (`[` `]` 不可)。 */
export function isBot(user) {
  if (!user) return true; // 投稿者不明 (削除済みユーザ = ghost 等) は信頼しない
  if (user.type === "Bot") return true;
  return typeof user.login === "string" && user.login.endsWith("[bot]");
}

/** 判定材料にしてよい投稿 (信頼できる人間の、automerge 自身のものではない投稿) か。 */
export function isTrustedHumanPost(item) {
  if (!item || isBot(item.user)) return false;
  if (!TRUSTED_ASSOCIATIONS.includes(item.author_association)) return false;
  const body = typeof item.body === "string" ? item.body : "";
  return !body.includes(AUTOMERGE_MARKER);
}

/**
 * 指示として読まない部分 (コードブロック・インラインコード・引用行・HTML コメント)
 * を取り除く。改行は残す (行単位のコマンド判定に使うため)。
 */
export function stripNonDirectiveText(body) {
  if (typeof body !== "string") return "";
  let text = body.replace(/\r\n?/g, "\n");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  // フェンス付きコードブロック (``` / ~~~)。閉じていない場合は末尾までをコード扱い。
  text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, "");
  // インラインコード
  text = text.replace(/`+[^`\n]*`+/g, "");
  // 引用行
  text = text
    .split("\n")
    .filter((line) => !/^[ \t]*>/.test(line))
    .join("\n");
  return text;
}

/**
 * 本文中の保留コマンドを返す。コマンドは「その行が `/hold` だけ」の形に限る
 * (文中の `/hold` は説明文の可能性があるため数えない)。1 つの本文に複数ある
 * 場合は最後のものが勝つ。
 * @returns {"hold" | "unhold" | null}
 */
export function parseHoldCommand(body) {
  let result = null;
  for (const raw of stripNonDirectiveText(body).split("\n")) {
    const line = raw.trim().toLowerCase();
    if (line === "/unhold" || line === "/hold cancel") result = "unhold";
    else if (line === "/hold") result = "hold";
  }
  return result;
}

/** 変更依頼の定型句を検出したら、マッチした文字列を返す。無ければ null。 */
export function detectChangeRequest(body) {
  const text = stripNonDirectiveText(body).toLowerCase();
  for (const pattern of CHANGE_REQUEST_PATTERNS) {
    const m = pattern.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** ISO 8601 をエポックミリ秒へ。解釈できなければ null。 */
function toEpoch(value) {
  if (typeof value !== "string" || value === "") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function describe(event) {
  const who = event.login ?? "?";
  return `${event.kind === "review" ? "レビュー" : "コメント"} by @${who} (${event.at ?? "時刻不明"})${event.url ? ` ${event.url}` : ""}`;
}

/**
 * マージ保留かどうかを判定する。
 *
 * @param {object} input
 * @param {string[]} [input.labels] PR のラベル名
 * @param {object[]} [input.comments] REST `GET /issues/{n}/comments` の要素
 * @param {object[]} [input.reviews] REST `GET /pulls/{n}/reviews` の要素
 * @param {string} [input.pushObservedAt] head の push 観測時刻 (ISO 8601)。
 *   取れなかった場合は空 — そのとき定型句の保留は push で解除できない (安全側)。
 * @param {string} [input.holdLabel] 保留ラベル名
 * @returns {{ hold: boolean, reasons: string[] }}
 */
export function evaluateHold(input) {
  const labels = Array.isArray(input?.labels) ? input.labels : [];
  const comments = Array.isArray(input?.comments) ? input.comments : [];
  const reviews = Array.isArray(input?.reviews) ? input.reviews : [];
  const holdLabel = input?.holdLabel || DEFAULT_HOLD_LABEL;
  const pushAt = toEpoch(input?.pushObservedAt);
  const reasons = [];

  // 1. 保留ラベル
  if (labels.includes(holdLabel)) {
    reasons.push(`保留ラベル '${holdLabel}' が付いています (外すと解除)。`);
  }

  // 2 / 4. コメントとレビュー本文を時系列に並べ、/hold・/unhold・定型句を畳み込む。
  //    編集されたコメントは「最後に編集した時点でその意図を表明した」と見なして
  //    updated_at を使う (push 後に依頼を追記した場合も保留になる)。
  const events = [];
  for (const c of comments) {
    if (!isTrustedHumanPost(c)) continue;
    events.push({
      kind: "comment",
      login: c.user?.login,
      at: c.updated_at || c.created_at,
      url: c.html_url,
      body: c.body,
    });
  }
  for (const r of reviews) {
    if (!isTrustedHumanPost(r)) continue;
    if (r.state === "PENDING") continue; // 未提出の下書きは本人にしか見えない
    events.push({ kind: "review", login: r.user?.login, at: r.submitted_at, url: r.html_url, body: r.body });
  }
  // 時刻不明のものは最後 (= 最新扱い) に置き、それ自身の /unhold は数えない
  // (保留を消す側にだけは倒さない)。
  const order = (e) => toEpoch(e.at) ?? Number.MAX_SAFE_INTEGER;
  events.sort((a, b) => order(a) - order(b));

  let hardHold = null;
  let softHolds = [];
  for (const e of events) {
    const cmd = parseHoldCommand(e.body);
    if (cmd === "unhold") {
      if (toEpoch(e.at) === null) continue;
      hardHold = null;
      softHolds = [];
      continue; // 解除コメント中の定型句 (「do not merge は解除」等) は数えない
    }
    if (cmd === "hold") {
      hardHold = e;
      continue;
    }
    const phrase = detectChangeRequest(e.body);
    if (phrase) softHolds.push({ ...e, phrase });
  }

  if (hardHold) {
    reasons.push(`/hold が指定されています: ${describe(hardHold)} (信頼できるユーザの /unhold で解除)。`);
  }
  for (const s of softHolds) {
    const at = toEpoch(s.at);
    // push 観測時刻が依頼より「厳密に後」のときだけ、依頼への対応 push と見なして解除。
    if (pushAt !== null && at !== null && pushAt > at) continue;
    reasons.push(
      `変更依頼 "${s.phrase}" が残っています: ${describe(s)} (以後の push か /unhold で解除)。`,
    );
  }

  // 3. CHANGES_REQUESTED レビュー (レビュアごとの最新の状態変化レビュー)。
  const latestByReviewer = new Map();
  for (const r of reviews) {
    if (!isTrustedHumanPost({ ...r, body: "" })) continue; // 本文のマーカー有無は問わない
    if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) continue;
    const login = r.user.login;
    const prev = latestByReviewer.get(login);
    const t = toEpoch(r.submitted_at) ?? Infinity;
    if (!prev || t >= prev.t) latestByReviewer.set(login, { t, review: r });
  }
  for (const [login, { review }] of latestByReviewer) {
    if (review.state === "CHANGES_REQUESTED") {
      reasons.push(
        `@${login} が変更を要求しています (Request changes, ${review.submitted_at ?? "時刻不明"})。承認し直すか dismiss すると解除。`,
      );
    }
  }

  return { hold: reasons.length > 0, reasons };
}

// CLI: 標準入力の JSON を evaluateHold に渡し、結果の JSON を標準出力へ書く。
// 入力が壊れていたら exit 2 (ワークフローは set -e で止まる = マージしない側)。
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    process.stderr.write(`automerge-hold: 入力 JSON を解釈できません: ${err}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(evaluateHold(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
