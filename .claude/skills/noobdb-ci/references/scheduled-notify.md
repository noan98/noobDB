# 定期 / 可視化専用ワークフローの結果通知 (#1395)

`audit.yml` (週次) / `e2e.yml` (nightly) / `mutants.yml` / `js-mutants.yml` (手動) は
どれも失敗させない設計で、結果は Job Summary / artifact に出るだけだった。見に行かなければ
腐る (silent rot) ため、各ワークフローに **`notify` ジョブ**を足し、検出 / 失敗時に
トラッキング Issue を自動で open / update し、回復したら自動で close する。

## 仕組み

- 実体は `scripts/upsert-tracking-issue.sh` (`gh` CLI のみ、外部 action なし)。環境変数
  `TRACK_LABEL` / `TRACK_STATE` (`problem` | `ok`) / `TRACK_TITLE` / `TRACK_BODY_FILE` /
  `TRACK_EXTRA_LABELS` / `TRACK_DEDUP_KEY` / `DRY_RUN=1` で動く。
- 重複防止は **固定ラベル + open Issue 検索**。あればコメント追記、無ければ作成
  (ラベルが無ければ `gh label create` で自動作成。`--force` は既存ラベルの色 / 説明を上書きするため使わず、`ci:*` は固定色 + 説明、cost / benefit は固定色で作る。既存なら失敗を `|| true` で吸収)。`ok` なら「回復」コメント + close。
- `TRACK_DEDUP_KEY` が直近の通知 (本文 / コメント中の `<!-- tracking-key: ... -->`) と同じ
  ならコメントを省略する (mutants 系のノイズ対策)。直近キーは Issue 本文 + `gh api --paginate` で全コメントを読んで取得する (コメント 100 件超でも最新を見る)。
- 生成 Issue には `.claude/rules/issues-and-prs.md` に従い cost / benefit ラベルを付ける。

| ワークフロー | ラベル | cost / benefit | problem 条件 | ok (close) 条件 |
|---|---|---|---|---|
| `audit.yml` | `ci:audit` | Low / 3 | `pnpm audit --json` の `metadata.vulnerabilities` 合計 > 0 (`found`)。JSON が取れない (`error`) は別タイトル・別キーで通知し、close はしない | 合計 0 (`clean`) |
| `e2e.yml` | `ci:e2e-nightly` | Mid / 3 | `e2e-linux` が failure | success |
| `mutants.yml` | `ci:mutants` | Mid / 4 | 実行失敗 (スコアが `n/a` = 母数 0 も含む)、または生存変異 > 0 (結果が前回と変わったときだけ追記) | 正常終了かつ生存 0 |
| `js-mutants.yml` | `ci:js-mutants` | Mid / 4 | 同上 (Stryker のスコア取得可否で実行成否を判定) | 同上 |

## 守ること

- **権限は `notify` ジョブにだけ `issues: write` を付ける。** 本体ジョブ / ワークフロー
  既定の `permissions: contents: read` は増やさない。
- `if` は 3 条件の AND にする: `always()`、`github.event_name == 'schedule' || 'workflow_dispatch'`、
  `github.ref == format('refs/heads/{0}', github.event.repository.default_branch)`、
  加えて本体ジョブの結果が `success` / `failure` (キャンセル・スキップでは通知しない)。
  **既定ブランチ以外の workflow_dispatch では通知しない** (試験ブランチの結果で Issue を
  open / close しないため)。新しい定期ワークフローを足すときも同じガードにする。
- multiline の job output は heredoc 区切りをランダム値 (`openssl rand -hex 16`) にし、
  末尾改行を補う。Issue 本文に貼る出力は `~~~~` で囲む (中のバッククォートで崩れない)。
- 本体ジョブは `outputs:` で終了コード / スコア / 生存数を `notify` に渡す。
  (`exit_code` / `score` / `survived` の step output 名を変えるときは `notify` も直す。)
- Issue のタイトル・本文は日本語、時刻は JST。秘密情報は含めない。
- ローカル確認は `gh` をモックした PATH で `DRY_RUN=1 TRACK_STATE=... bash scripts/upsert-tracking-issue.sh`。
