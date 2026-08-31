# CodeRabbit レビューゲート (#1055)

PR のレビュー層は CodeRabbit が担い、`.github/workflows/` の 3 ワークフローが
連携します。**CodeRabbit はこのリポジトリでは自動レビューを行いません** — star 数が
閾値 (10) 未満の OSS リポジトリは対象外という CodeRabbit 側の仕様で、PR には毎回
「This repository does not receive automatic reviews because it has fewer than 10
stars」というサマリコメントが付き、コミットステータスも
`Review skipped: manual review required for this OSS repository` で **success** に
なります。

この「恒久 skip」は、レートリミットによる一過性の skip と**まったく別物**です。
以前はどちらも `skip review by coderabbit.ai` という同じマーカーで表現されるため
`automerge.yml` が一括りに「待っても進まないので通す」と判定しており、結果として
**レビューが 1 度も行われないまま自動承認 → 自動マージまで通り、しかもその事実が
パイプライン上のどこにも異常として現れませんでした** (#1055。#1042〜#1050 が
この状態でマージされています)。現在は次の 3 段構えで解消しています。

- **`coderabbit-request-review.yml` (新設) — レビューの明示起動**。coderabbitai[bot]
  のサマリコメントに `skip review by coderabbit.ai` マーカーを検出したら、その PR の
  現在の head SHA に対して `@coderabbitai review` を **1 回だけ**投稿します
  (CodeRabbit 自身が案内している正規の回避手段)。重複と無限ループの抑止は
  `coderabbit-fallback-approve.yml` と同じく、投稿本文へ head SHA 入りの識別タグ
  `<!-- coderabbit-request-review: <sha> -->` を埋める方式です。push で head が
  進めば新しい SHA として再度 1 回だけ起動します。

  **ただし現状この投稿は効きません (要 PAT)。** 実地検証の結果、CodeRabbit は
  **GITHUB_TOKEN 由来 (= github-actions[bot] が author の) コマンドコメントに一切
  反応しません** (PR #1059 で投稿後 40 分以上待ってもレビュー提出・返信ともに無し。
  多くのレビュー bot が無限ループ防止のため bot 由来コマンドを無視するのと同じ)。
  レビューを実際に走らせたい場合は `repo` スコープの**人間ユーザの PAT** を Secrets
  (例 `CODERABBIT_PAT`) に登録し、同ワークフローの `GH_TOKEN` を差し替えてください。
  PAT を用意しない間、このワークフローは PR ごとに 1 コメントを残すだけの no-op です
  (レビュー不在自体は下の Step 5a が警告として可視化するので見逃しにはなりません)。
- **`automerge.yml` の Step 5a — 可視化 (待たない)**。skip 宣言を検出したら、まず現在の
  head に対する CodeRabbit のレビュー提出を確認し、あれば skip フラグを下ろして
  通常経路 (Step 5b/6) へ委ねます (PAT 構成にした場合はここに倒れます)。無ければ
  **マージは継続しつつ** `::warning::` アノテーションと Job Summary に「レビューゲートが
  素通りしています」を出力します (黙って通さない)。
  当初は明示起動した `@coderabbitai review` の結果を猶予時間 (20 分) だけ待つ設計に
  しましたが、上記のとおり待ってもレビューは来ず、かつ**猶予切れ後に automerge を
  再評価するイベントが来ないため PR が無期限に停止する**副作用だけが残ったので撤廃
  しました。マージを止めない方針自体は、バンドルサイズ (#443) ・カバレッジ (#482) と
  同じ「まず可視化」の漸進方針に沿ったものです。
- **`coderabbit-fallback-approve.yml` の条件 4 — レビュー未実施 PR を承認しない**。
  投稿条件だった「CodeRabbit のステータスが SUCCESS」「未解決スレッドが 0 件」は、
  **レビューが 1 度も行われていない PR でも自動的に満たされます** (上記のとおり
  status は success、スレッドは 1 件も作られないので 0 件)。本ワークフローが本来
  想定しているのは「CodeRabbit が指摘を出し、全スレッドを解決したのに自発的に
  Approved を出さない」ケースなので、**CodeRabbit のレビュー提出が 1 件も無い PR
  では承認を投稿せず、警告だけ残して抜けます**。head SHA との一致までは要求しません
  — 指摘を受けて修正を push した直後は最新 head へのレビューがまだ無いのが正常で、
  本来の用途を壊すためです (head へのレビュー提出待ちは `automerge.yml` の Step 5b が
  担います)。

**`skip review` マーカーの扱いを変更するときは 3 ファイルを揃えて見直してください。**
`automerge.yml` のコメントが述べる前提と実際の挙動が食い違うと、#1055 と同じ
「気付けない」状態に戻ります。
