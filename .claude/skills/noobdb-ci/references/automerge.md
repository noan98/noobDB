# automerge.yml の判定フロー

`automerge.yml` (関連ワークフローはこの 1 本だけ) は、次の条件がすべて揃った open PR を
自動で main へマージします。**人間の承認もレビュー bot の完了も要求しません。**

1. 対象は OPEN・非ドラフト・ベースが `main`・`mergeable`
2. `ci.yml` の最新 run (head SHA) が success
3. **変更依頼ゲート (Step 4b, #1108)** — 人間の「待った」が残っていない (下記)
4. **未解決のレビュースレッドが 0 件 (Step 6)** — 投稿者は問わない
5. `mergeStateStatus` が CLEAN / UNSTABLE / HAS_HOOKS (直前に Step 4b をやり直し、
   `--match-head-commit` で評価した head 以外をマージしない)

## Codex レビューゲートの撤去

以前 (#1109) は Step 5 で「Codex (`chatgpt-codex-connector[bot]`) が現在の head SHA を
レビュー済み」であることを要求していましたが、**Codex の利用上限 (レートリミット) で
PR が止まりやすく運用に合わなかったため撤去しました。** 同時に次も削除しています。

- `automerge-without-codex` ラベル (Codex 要件の免除ラベル。ゲートが無いので不要)
- Secrets `CODEX_PAT` と `@codex review` の自動投稿
- Codex の利用上限メッセージ・👍 リアクション・`Reviewed commit:` 行の判定
- `automerge.yml` の起動条件にあった Codex bot の例外

レビュー層はこれで「人間の待った (Step 4b) + 未解決スレッド (Step 6)」の 2 段です。
**Codex が自発的に付けた指摘は消えていません。** 未解決スレッドとして残っていれば
投稿者を問わない Step 6 が拾うので、マージはされません。ただし Codex の応答を
待たなくなったため、指摘が付く前にマージされることはありえます。

その前の CodeRabbit も、レートリミットが厳しく GitHub App をアンインストール済みです
(`coderabbit-*.yml` は削除済み。`src/` や `src-tauri/tests/` に残る CodeRabbit への
言及は修正の経緯を説明する履歴なので消していません)。

**レビュー層を復活させるときは**、head SHA に対する完了信号 (レビュー提出または
👍) を待つこと、`push` 観測時刻に git の committer date を使わないこと (check-suite の
作成時刻の最小値だけを使う)、利用上限で永久停止しない逃げ道を用意することの 3 点を
押さえてください。このゲートを撤去するコミットより前の `automerge.yml` (git 履歴) に実装があります。

## 関連する環境変数 (`automerge.yml` の `env`)

| 変数 | 既定値 | 役割 |
|---|---|---|
| `HOLD_LABEL` | `do-not-merge` | 付いている間は自動マージしない (Step 4b の変更依頼ゲート。**止める側**のラベル) |

## 変更依頼ゲート (Step 4b, #1108)

PR #1101 で、オーナーが「この点を修正してから merge 推奨」を **通常コメント
(issue comment)** で投稿した直後に automerge がマージしました。Step 6 は未解決の
レビュースレッドしか見ず、通常コメントや本文だけのレビュー (Request changes を
含む) はスレッドを作らないため取りこぼしていました。Step 4b はこれを塞ぎます。

判定ロジックは **`scripts/automerge-hold.mjs`** (純関数) にあり、
`scripts/automerge-hold.test.mjs` (`pnpm run test:scripts`、ci.yml の
`automerge gate (script tests)` ジョブ) で境界ケースを固定しています。
ワークフローは既定ブランチ (main) からこのスクリプトだけを sparse checkout して
実行します (PR 側のコードは実行しない)。

| 信号 | 解除方法 | push で解除 |
|---|---|---|
| `do-not-merge` ラベル (`HOLD_LABEL`) | ラベルを外して PR にコメント (再評価) | しない |
| `/hold` だけの行 (コメント / レビュー本文) | 信頼できるユーザの `/unhold` (または `/hold cancel`) | しない |
| Request changes (`CHANGES_REQUESTED` が各レビュアの最新状態) | 承認し直す / dismiss | しない |
| 変更依頼の定型句 (「修正してから merge」「マージしないで」「do not merge」「fix ... before merging」等) | 依頼より後の push、または `/unhold` | **する** |

- 読むのは **OWNER / MEMBER / COLLABORATOR の人間の投稿だけ**。bot (Codex /
  `github-actions[bot]` / その他 `[bot]`) と `<!-- automerge:` マーカー付きの
  投稿は無視します (Codex の指摘は Step 6 がスレッドで拾う)。
- コードブロック・インラインコード・引用行 (`>`)・HTML コメントの中は読みません。
  `/hold` は「その行が `/hold` だけ」のときだけコマンドとして扱います。
- 定型句の保留は、**依頼より後に head が push されたら解除**します (対応 push で
  意図が満たされる前提)。新しい head は CI を通り直すので、無審査にはなりません。
  push で解けない保留が欲しいときは `/hold` を使います。
  push 観測時刻が取れないときは push では解除しません (安全側)。
- 判定は Step 7 のマージ直前にもう一度やり直し、`gh pr merge
  --match-head-commit` で評価した head 以外をマージしないようにしています。
- 取得・判定に失敗したらジョブを `::error::` で落とします (fail-closed)。
  `if check_hold` の条件部では `set -e` が効かないため、関数内の各コマンドに
  明示的な失敗処理を付けています。**これを外すと失敗時に「保留なし」へ倒れます。**

### 設計上の落とし穴 (Step 4b)

- **定型句を増やすときは、止まるべき文と止まってはいけない文を両方テストに足す。**
  誤検出が増えると automerge が実質無効化されます (レビューが付かない PR は
  従来どおり通すのが受け入れ条件)。
- **信頼できない投稿者の判定を緩めない。** public リポジトリなので、誰でも
  コメントで任意の PR を止められる DoS になります。
