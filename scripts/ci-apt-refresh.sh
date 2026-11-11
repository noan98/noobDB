#!/usr/bin/env bash
# CI の apt インデックスを最新化するスクリプト (ランナーの古いインデックス対策)。
#
# ランナーイメージに焼き込まれた apt インデックスは古く、アーカイブから消えた旧版の
# .deb を参照して 404 になることがある (2026-07-23 の gst-plugins-good、2026-11-12 の
# libsoup3)。そこでミラーを本家 archive.ubuntu.com 優先に差し替えて apt-get update
# する。
#
# 2026-11-12 (JST) には archive.ubuntu.com の名前解決がランナーから断続的に失敗し、
# 本家だけを指していたため update が丸ごと失敗 → 古いインデックスのまま 404 →
# cache-apt-pkgs-action が「0 パッケージの空キャッシュ」を保存して Rust ジョブが
# 全滅した。そのため Azure ミラー / security を後順位のフォールバックとして残し、
# 取得失敗が残る間は数回やり直す。最終的に失敗が残っても止めない (後段の
# ci-apt-ensure.sh が実際に必要なものが入ったかを確かめる)。
set -uo pipefail

printf '%s\n' \
  "http://archive.ubuntu.com/ubuntu/	priority:1" \
  "http://azure.archive.ubuntu.com/ubuntu/	priority:2" \
  "http://security.ubuntu.com/ubuntu/	priority:3" \
  | sudo tee /etc/apt/apt-mirrors.txt >/dev/null

for attempt in 1 2 3; do
  log=$(sudo apt-get update -o Acquire::Retries=3 -o Acquire::http::Timeout=30 2>&1)
  echo "$log"
  if ! echo "$log" | grep -qE '^(W|E): (Failed to fetch|Some index files failed)'; then
    exit 0
  fi
  echo "::warning::apt-get update で取得に失敗したインデックスがあります (試行 ${attempt}/3)"
  sleep $((attempt * 10))
done
exit 0
