# Codex レビューゲート (#1109)

PR のレビュー層は **Codex (`chatgpt-codex-connector[bot]`)** が担い、
`automerge.yml` の Step 5 / Step 6 が「レビューが済むまでマージしない」ゲートに
なっています。その手前の Step 4b が「人間の変更依頼が残っていたらマージしない」
ゲート (#1108) です。関連ワークフローは `automerge.yml` の **1 本だけ**です。

## CodeRabbit からの移行 (#1109)

以前のレビュー層は CodeRabbit でしたが、レートリミットが厳しく実用に耐えなかった
ため **GitHub App をアンインストール**し、Codex へ移行しました。撤去したもの:

- `.github/workflows/coderabbit-request-review.yml` (削除)
- `.github/workflows/coderabbit-fallback-approve.yml` (削除)
- `automerge.yml` の CodeRabbit 依存 (Step 5 / 5a / 5b) → Codex ベースへ作り替え
- Secrets `CODERABBIT_PAT` の想定 → `CODEX_PAT` へ置き換え

**`src/` と `src-tauri/tests/` に残る CodeRabbit への言及は消していません。**
`ResultGrid.tsx` / `App.tsx` / `alterTable.test.ts` / `duckdb_integration.rs` の
コメントは「なぜこの修正・回帰テストが存在するか」を説明する履歴で、内容は今も
正しいためです。

先行して同じ移行を済ませた **VeloX リポジトリ** (`auto-merge.yml` /
`.github/scripts/check_review_gate.py`) を参照して判定方式を揃えています。判定方式を
変えるときは VeloX 側も確認してください。

## Codex の実測挙動 (判定方式の根拠)

`automerge.yml` の判定は次の観測事実に基づいています。文言や挙動が変わったら
ここと `automerge.yml` の冒頭コメントを揃えて直してください。

| 状況 | Codex の振る舞い | 観測元 |
|---|---|---|
| 指摘あり | `state: COMMENTED` のレビューを提出。`commit_id` にレビュー対象の head SHA が入り、本文に `**Reviewed commit:** \`94ffecb297\`` の定型行が付く | noobDB PR #1099 |
| **指摘なし** | **レビューを提出せず、PR 本体に 👍 リアクションだけを付ける** (issue reaction の `THUMBS_UP`) | Codex の案内文 + VeloX PR #191 |
| 利用上限 | issue comment で `You have reached your Codex usage limits for code reviews.` を投稿し、レビューは 1 件も提出しない | noobDB PR #1101 / #1105 / #1106 |
| トリガ | PR の open / draft → ready / `@codex review` コメントの 3 つだけ。**push は含まれない** | Codex の案内文 |

**特に重要な 2 点**:

1. **指摘ゼロのときは 👍 しか返らない。** 「head へのレビュー提出」だけを完了信号に
   すると、クリーンな PR が永久にマージされません。
2. **push では再レビューしない。** 指摘に対応して push しただけでは head SHA は
   永遠に未レビューのままになります。

## `automerge.yml` Step 5 の判定フロー

```
automerge-without-codex ラベル → 免除して Step 6 へ (::warning::)
  ↓ なし
head の push 観測時刻を取得 (check-suite の created_at の最小値)
  取得できない → 安全側でスキップ
  ↓
Codex の完了信号 (以下の OR) があるか
  (a-1) レビューの commit_id == head SHA
  (a-2) レビュー本文の "Reviewed commit: <短縮SHA>" が head SHA と前方一致
  (b)   Codex の 👍 リアクションが push 観測時刻以降
  → あり: Step 6 (未解決スレッド 0 件) へ
  ↓ なし
この head に対する利用上限メッセージがある → 緩和して通す (::warning:: + Job Summary)
  ↓ なし
push 観測時刻から CODEX_REREVIEW_DELAY_MINUTES (5 分) 未経過 → 待つ (スキップ)
  ↓ 経過
`@codex review` を未投稿なら 1 回だけ投稿 → 応答を待つ (スキップ)
  (CODEX_PAT 未設定なら投稿せず ::warning::)
  ↓
過去に利用上限メッセージを観測済み → 緩和して通す (永久停止の回避、::warning::)
  ↓ なし
待つ (スキップ)
```

### 設計上の落とし穴 (壊さないこと)

- **進行中マーカーだけで判定しない。** CodeRabbit 時代の PR #277 は、サマリコメントの
  進行中マーカーが実レビュー提出より早く消え、「マーカーなし + 未解決スレッド 0 件」が
  同時に成立して指摘が届く前にマージされた取りこぼしです。Codex でも「head SHA に
  対する完了信号」を確定信号として待つことでこの穴を塞いでいます。
- **push 観測時刻に git の committer date を使わない。** committer date は「commit を
  ローカルで作った時刻」であり push 時刻ではありません。cherry-pick / rebase で容易に
  過去の日時になるため、👍 判定 (b) が古い head 向けのリアクションを誤って
  「レビュー済み」と判定できてしまいます。GitHub がサーバ側で観測した時刻
  (head SHA の check-suite の `created_at` の最小値) だけを使い、**取得できなかった
  場合に committer date へフォールバックしてはいけません** (同じ穴を再現します)。
- **`@codex review` のマーカーは投稿が成功したときにしか残さない。** マーカー
  (`<!-- automerge:codex-review-request:<sha> -->`) はコメント本文の中にしか存在
  しません。もしマーカーだけを別途残す実装に変えると、その head SHA には二度と
  依頼が飛ばず PR が永久に停止します。
- **👍 リアクションはイベントを生まない。** そのため 👍 だけを待って automerge を
  再評価する経路はありません。実運用では CI (数十分) の完了が Codex の応答 (数分)
  より遅いため `workflow_run` で拾えますが、取りこぼした場合は PR に何かコメント
  すれば再評価されます (ジョブの `if` が OWNER / MEMBER / COLLABORATOR のコメントを
  通しているのはこの再評価の手段も兼ねています)。
- **緩和は黙って行わない。** レビューなしで通す分岐 (利用上限・免除ラベル) は必ず
  `::warning::` と Job Summary に出します。#1055 で「レビュー不在がパイプライン上の
  どこにも異常として現れなかった」失敗を繰り返さないためです。
- **免除ラベルは Codex 要件だけを免除する。** `automerge-without-codex` は Step 6 の
  未解決スレッド判定を免除しません (人間 / bot の明示的な指摘を尊重するため)。

## メンテナ向けのセットアップ: `CODEX_PAT`

`@codex review` の自動投稿には Secrets **`CODEX_PAT`** (`repo` スコープの
**人間ユーザの PAT**) が必要です。

`GITHUB_TOKEN` (= `github-actions[bot]` として投稿) ではレビュー bot が反応しない
ことは実測済みです。CodeRabbit では PR #1059 で投稿後 40 分以上待っても無反応、
VeloX では PR #200 で `@codex review` に対し Codex が「To use Codex here, create a
Codex account and connect to github.」と返すのみでレビューを実行しませんでした
(多くのレビュー bot が無限ループ防止のため bot 由来のコマンドを無視します)。
そのため **`CODEX_PAT` が無い場合は投稿しません** — 空打ちして「依頼が届いた」と
誤認させるより投稿しない方が安全側です。

`CODEX_PAT` 未設定のまま修正 push を重ねると、head が未レビューのまま PR が停止
します。その場合は次のいずれかで解消してください。

1. 人間が PR に `@codex review` とコメントする (Codex は人間の投稿には反応します)
2. `automerge-without-codex` ラベルを付けて Codex 要件を免除する

## 関連する環境変数 (`automerge.yml` の `env`)

| 変数 | 既定値 | 役割 |
|---|---|---|
| `CODEX_LOGIN` | `chatgpt-codex-connector[bot]` | Codex のログイン名。**完全一致**で照合する (`chatgpt-codex-connector-review` のような別名が前方一致ですり抜けないように) |
| `CODEX_REREVIEW_DELAY_MINUTES` | `5` | push 観測時刻からこの分数を過ぎても完了信号が無ければ `@codex review` を 1 回投稿する。短すぎると自動レビューと依頼が二重に走り、長すぎると修正 push 後の停止時間が伸びる |
| `CODEX_BYPASS_LABEL` | `automerge-without-codex` | Codex のレビュー要件だけを免除するラベル |
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
  意図が満たされる前提)。新しい head は Step 5 で Codex の再レビューが要るので
  無審査にはなりません。push で解けない保留が欲しいときは `/hold` を使います。
  push 観測時刻が取れないときは push では解除しません (安全側)。
- **Codex 免除ラベル (`automerge-without-codex`) でも Step 4b は免除しません。**
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
