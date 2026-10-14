// automerge が「マージできなかった」ことを PR に 1 件だけ残すコメントの判定ロジック (#1632)。
//
// `.github/workflows/automerge.yml` から呼ばれる。以前は判定失敗 (hold_fail) や
// リトライ後のマージ失敗で PR に何も残らず、ログを見に行かないと取り残された
// 理由が分からなかった。ここでは「新規作成 / 既存コメントの更新 / 何もしない」の
// 判定と本文の組み立てだけを純関数で行い (ネットワークにも触らない)、
// `scripts/automerge-notice.test.mjs` で境界ケースを固定する。
//
// ## 自己再帰しない理由
// - 本文に `<!-- automerge:` を含むので、automerge.yml の issue_comment トリガの
//   `if` (マーカー入りを除外) と automerge-hold.mjs (マーカー入りを無視) の両方で
//   判定材料から外れる。
// - GITHUB_TOKEN が作ったコメントは、そもそも別のワークフローを起動しない。
// - 既存コメントの探索は **bot の投稿に限る**。人間がマーカーを真似て書いても
//   (編集の対象にも「解消済み」の判定にも) 使わない。
import { pathToFileURL } from "node:url";

import { AUTOMERGE_MARKER, isBot } from "./automerge-hold.mjs";

// PR 単位で 1 件だけ持つコメントの識別子。AUTOMERGE_MARKER で始まること。
export const NOTICE_MARKER = `${AUTOMERGE_MARKER} notice -->`;

export const KINDS = ["hold_fail", "merge_failed", "resolved"];

// PR 上の automerge の通知コメント (bot 投稿 + マーカー入り) を探す。複数あれば最初の 1 件。
export function findNotice(comments) {
  for (const c of comments ?? []) {
    if (!isBot(c?.user)) continue;
    if (typeof c?.body === "string" && c.body.includes(NOTICE_MARKER)) return c;
  }
  return null;
}

function runLine(runUrl) {
  return runUrl ? `\n\n実行ログ: ${runUrl}` : "";
}

export function buildBody({ kind, headSha, mergeStateStatus, detail, runUrl }) {
  const sha = headSha ? ` (head \`${headSha}\`)` : "";
  switch (kind) {
    case "hold_fail":
      return `${NOTICE_MARKER}
### :warning: automerge: 変更依頼ゲートの判定に失敗したためマージしていません${sha}

${detail || "判定材料を取得できませんでした。"}

安全側でマージを見送っています。原因を解消したうえで、PR にコメントするか CI を再実行すると再評価されます。${runLine(runUrl)}`;
    case "merge_failed":
      return `${NOTICE_MARKER}
### :warning: automerge: リトライ後もマージできませんでした${sha}

- 最後に観測した mergeStateStatus: \`${mergeStateStatus || "不明"}\`
${detail ? `- ${detail}\n` : ""}
次の CI 完了・レビュー・コメントのいずれかで自動的に再評価されます。${runLine(runUrl)}`;
    case "resolved":
      return `${NOTICE_MARKER}
### :white_check_mark: automerge: 解消しました (マージ済み)

以前ここに記載していたマージ見送りの理由は解消し、PR はマージされました。${runLine(runUrl)}`;
    default:
      throw new Error(`未知の kind: ${kind}`);
  }
}

// 戻り値: { action: "create" | "update" | "none", commentId?: number, body?: string }
export function planNotice({ comments, kind, ...rest }) {
  if (!KINDS.includes(kind)) throw new Error(`未知の kind: ${kind}`);
  const existing = findNotice(comments);
  if (kind === "resolved") {
    // 失敗の記録が無ければ何も書かない。既に解消済みなら重複編集しない。
    if (!existing) return { action: "none" };
    if (existing.body.includes("解消しました (マージ済み)")) return { action: "none" };
    return { action: "update", commentId: existing.id, body: buildBody({ kind, ...rest }) };
  }
  const body = buildBody({ kind, ...rest });
  if (!existing) return { action: "create", body };
  // 本文が同じなら API 呼び出しを省く (再評価のたびに更新通知を出さない)。
  if (existing.body === body) return { action: "none" };
  return { action: "update", commentId: existing.id, body };
}

// CLI: 標準入力の JSON を planNotice に渡し、結果の JSON を標準出力へ書く。
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    process.stderr.write(`automerge-notice: 入力 JSON を解釈できません: ${err}\n`);
    process.exit(2);
  }
  try {
    process.stdout.write(`${JSON.stringify(planNotice(input))}\n`);
  } catch (err) {
    process.stderr.write(`automerge-notice: ${err}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
