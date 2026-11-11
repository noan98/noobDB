#!/usr/bin/env bash
# cache-apt-pkgs-action の結果を確かめ、足りなければ apt-get install で入れ直す。
#
# 使い方: ci-apt-ensure.sh <パッケージ...>
#
# cache-apt-pkgs-action は install が失敗しても step を成功扱いにし、さらに
# 「0 パッケージの空キャッシュ」を保存してしまうことがある (2026-07-23 / 2026-11-12)。
# 空キャッシュが復元されると以後の実行は clang/mold や webkit が無いまま cargo に
# 進み、`invalid linker name '-fuse-ld=mold'` などで落ち続ける。ここで実際に使う
# コマンド / pkg-config モジュールを確かめ、欠けていたときだけ直接 install して救う
# (正常時は何もしないので、キャッシュヒット時の所要時間は変わらない)。
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <package...>" >&2
  exit 2
fi

missing=()
for cmd in clang mold pkg-config; do
  command -v "$cmd" >/dev/null 2>&1 || missing+=("command:$cmd")
done
for mod in webkit2gtk-4.1 gtk+-3.0 libsoup-3.0 librsvg-2.0 openssl; do
  pkg-config --exists "$mod" 2>/dev/null || missing+=("pkg-config:$mod")
done
for pkg in "$@"; do
  if [ "$pkg" = "openssh-server" ] && [ ! -x /usr/sbin/sshd ]; then
    missing+=("file:/usr/sbin/sshd")
  fi
done

if [ "${#missing[@]}" -eq 0 ]; then
  echo "apt の依存はそろっています。"
  exit 0
fi

echo "::warning::apt キャッシュの復元結果に不足があるため直接インストールします: ${missing[*]}"
bash "$(dirname "$0")/ci-apt-refresh.sh"
for attempt in 1 2 3; do
  if sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    -o Acquire::Retries=3 "$@"; then
    exit 0
  fi
  echo "::warning::apt-get install に失敗しました (試行 ${attempt}/3)"
  sleep $((attempt * 15))
  bash "$(dirname "$0")/ci-apt-refresh.sh"
done
echo "::error::apt の依存をインストールできませんでした: ${missing[*]}"
exit 1
