#!/usr/bin/env bash
# 定期 / 可視化専用ワークフローの検出結果を、トラッキング Issue として upsert する (#1395)。
#
# 使い方 (環境変数で渡す。ワークフローの通知ジョブから呼ぶ):
#   GH_TOKEN            必須。`issues: write` を持つトークン (github.token)。
#   GITHUB_REPOSITORY   必須。owner/repo (Actions が自動設定)。
#   TRACK_LABEL         必須。ワークフローごとの固定ラベル (例 ci:audit)。重複防止のキー。
#   TRACK_STATE         必須。`problem` (検出 / 失敗) か `ok` (回復 / 検出なし)。
#   TRACK_TITLE         problem 時の新規 Issue タイトル (日本語)。
#   TRACK_BODY_FILE     problem 時の本文 (Markdown) のファイル。Job Summary 相当の要約。
#   TRACK_EXTRA_LABELS  追加ラベル (カンマ区切り。cost:* / benefit:* を渡す)。新規作成時のみ付与。
#   TRACK_DEDUP_KEY     任意。直近の通知と同じキーなら追記コメントを省略する (mutants 系のノイズ対策)。
#   DRY_RUN=1           gh の書き込みを行わず、何をするかを標準出力に出す。
#
# 動作:
#   problem … TRACK_LABEL 付きの open Issue を検索し、あればコメント追記、無ければ作成。
#   ok      … open Issue があれば「回復した」とコメントして close。無ければ何もしない。
# 通知の失敗でワークフロー本体の結果を汚さないよう、gh の失敗は呼び出し側で扱う
# (このスクリプトは失敗時に非ゼロ終了する)。秘密情報は扱わない。
set -euo pipefail

: "${TRACK_LABEL:?TRACK_LABEL is required}"
: "${TRACK_STATE:?TRACK_STATE is required (problem|ok)}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

dry="${DRY_RUN:-0}"
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID:-0}"
now_jst="$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M')"

gh_write() {
  if [ "$dry" = "1" ]; then
    echo "[dry-run] gh $*"
  else
    gh "$@"
  fi
}

# 既存 open Issue (固定ラベル付き) を探す。読み取りは dry-run でも実行する。
existing="$(gh issue list --repo "$GITHUB_REPOSITORY" --label "$TRACK_LABEL" --state open \
  --limit 1 --json number --jq '.[0].number // empty')"

case "$TRACK_STATE" in
  problem)
    : "${TRACK_TITLE:?TRACK_TITLE is required for problem}"
    : "${TRACK_BODY_FILE:?TRACK_BODY_FILE is required for problem}"
    key="${TRACK_DEDUP_KEY:-}"
    body="$(mktemp)"
    {
      cat "$TRACK_BODY_FILE"
      echo ""
      echo "---"
      echo "検出日時: ${now_jst} JST / [ワークフロー実行](${run_url})"
      [ -n "$key" ] && echo "<!-- tracking-key: ${key} -->"
    } > "$body"

    if [ -n "$existing" ]; then
      if [ -n "$key" ]; then
        # コメントは gh issue view だと件数上限があるため、REST をページングして最新まで読む。
        last_key="$({
          gh issue view "$existing" --repo "$GITHUB_REPOSITORY" --json body --jq '.body'
          gh api --paginate "repos/${GITHUB_REPOSITORY}/issues/${existing}/comments" --jq '.[].body'
        } | grep -o '<!-- tracking-key: .* -->' | tail -n 1 || true)"
        if [ "$last_key" = "<!-- tracking-key: ${key} -->" ]; then
          echo "前回通知と同じ結果 (${key}) のためコメントを省略します (#${existing})"
          exit 0
        fi
      fi
      gh_write issue comment "$existing" --repo "$GITHUB_REPOSITORY" --body-file "$body"
    else
      # ラベルが無ければ作成する。--force は既存ラベルの色 / 説明を上書きする (cost:* /
      # benefit:* を壊す) ので使わず、既存なら失敗するだけなので `|| true` で吸収する。
      # --color を省くと gh はランダム色を選ぶため、必ず固定色を渡す。
      all_labels="${TRACK_LABEL}"
      [ -n "${TRACK_EXTRA_LABELS:-}" ] && all_labels="${all_labels},${TRACK_EXTRA_LABELS}"
      IFS=',' read -r -a arr <<< "$all_labels"
      args=()
      for l in "${arr[@]}"; do
        [ -n "$l" ] || continue
        case "$l" in
          ci:*) gh_write label create "$l" --repo "$GITHUB_REPOSITORY" --color 5319e7 \
                  --description "定期 / 可視化専用ワークフローのトラッキング Issue (自動生成)" || true ;;
          *)    gh_write label create "$l" --repo "$GITHUB_REPOSITORY" --color ededed || true ;;
        esac
        args+=(--label "$l")
      done
      gh_write issue create --repo "$GITHUB_REPOSITORY" --title "$TRACK_TITLE" \
        --body-file "$body" "${args[@]}"
    fi
    ;;
  ok)
    if [ -z "$existing" ]; then
      echo "open なトラッキング Issue は無いため何もしません (${TRACK_LABEL})"
      exit 0
    fi
    msg="$(mktemp)"
    printf '回復を確認しました (%s JST)。[ワークフロー実行](%s) で検出なし / 成功に戻ったため、この Issue を自動でクローズします。再発した場合は新しい Issue が作成されます。\n' \
      "$now_jst" "$run_url" > "$msg"
    gh_write issue comment "$existing" --repo "$GITHUB_REPOSITORY" --body-file "$msg"
    gh_write issue close "$existing" --repo "$GITHUB_REPOSITORY" --reason completed
    ;;
  *)
    echo "TRACK_STATE は problem か ok を指定してください: ${TRACK_STATE}" >&2
    exit 2
    ;;
esac
