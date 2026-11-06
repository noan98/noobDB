#!/usr/bin/env bash
# 外部 DB 統合テストの実行数と skip を Job Summary に出す (#2101)。
# tests/common/mod.rs の skip_capability / skip_external が NOOBDB_TEST_SKIP_LOG へ 1 行ずつ追記する。
# 実行数は nextest の最終 Summary 行 (例: "Summary [  12.3s] 1234 tests run: 1230 passed, 4 skipped") を
# 控えた出力ファイルから取る。可視化のみで fail はさせない (env 欠落の skip は
# NOOBDB_TEST_REQUIRE_EXTERNAL=1 でテスト側が panic する)。
# 使い方: ci-skip-summary.sh <skip ログのパス> <ジョブ名> [nextest 出力ファイル]
set -euo pipefail
log="${1:?skip log path}"
job="${2:?job name}"
nextest_out="${3:-}"
out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
{
  echo "### ${job} 外部テストの実行数と skip"
  echo ""
  summary=""
  if [ -n "$nextest_out" ] && [ -s "$nextest_out" ]; then
    summary="$(grep -E 'Summary \[.*tests? run:' "$nextest_out" | tail -n 1 || true)"
  fi
  if [ -n "$summary" ]; then
    echo "nextest: \`${summary}\`"
  else
    echo "nextest: 未実行 (Summary 行なし。テストが走る前に失敗したか、このイベントでは実行しない)"
  fi
  echo ""
  if [ -s "$log" ]; then
    echo "テスト内 skip 件数 (サーバ機能の有無による skip): $(wc -l < "$log" | tr -d ' ')"
    echo ""
    echo '```'
    sort "$log" | uniq -c | sort -rn
    echo '```'
  else
    echo "テスト内 skip 件数: 0 (env 欠落による skip は NOOBDB_TEST_REQUIRE_EXTERNAL=1 で失敗扱い)"
  fi
  echo ""
} >> "$out"
