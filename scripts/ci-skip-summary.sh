#!/usr/bin/env bash
# 外部 DB 統合テストの skip を Job Summary に出す (#2101)。
# tests/common/mod.rs の skip_capability / skip_external が NOOBDB_TEST_SKIP_LOG へ 1 行ずつ追記する。
# 可視化のみで fail はさせない (env 欠落の skip は NOOBDB_TEST_REQUIRE_EXTERNAL=1 でテスト側が panic する)。
# 使い方: ci-skip-summary.sh <skip ログのパス> <ジョブ名>
set -euo pipefail
log="${1:?skip log path}"
job="${2:?job name}"
out="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
{
  echo "### ${job} 外部テストの skip"
  echo ""
  if [ -s "$log" ]; then
    echo "skip 件数: $(wc -l < "$log" | tr -d ' ')"
    echo ""
    echo '```'
    sort "$log" | uniq -c | sort -rn
    echo '```'
  else
    echo "skip 件数: 0 (env 欠落による skip は NOOBDB_TEST_REQUIRE_EXTERNAL=1 で失敗扱い)"
  fi
  echo ""
} >> "$out"
