#!/usr/bin/env bash
# SSH トンネル統合テスト (#331) 用の sshd をセットアップするスクリプト。
#
# CI の `rust (test)` ジョブから呼び、パスワード認証用のテストユーザと鍵認証用の
# 鍵ペアを用意し、ローカルの 127.0.0.1:2222 で sshd を起動する。最後にテストが参照
# する環境変数 (NOOBDB_TEST_SSH_URL / NOOBDB_TEST_SSH_KEY) を $GITHUB_ENV に追記する
# (CI 以外で実行した場合は標準出力に export 文を出す)。
#
# linuxserver/openssh-server などのサービスコンテナに頼らず、apt の openssh-server を
# 直接構成する方式にしている (イメージ pull 不要で、ローカルでも同手順を再現・検証
# できる)。ローカル検証時は SSH_PORT / SSH_DIR / SSH_USER を上書きできる。
set -euo pipefail

SSH_PORT="${SSH_PORT:-2222}"
SSH_DIR="${SSH_DIR:-/tmp/noobdb-sshtest}"
SSH_USER="${SSH_USER:-sshtest}"
SSH_PASS="${SSH_PASS:-sshpw123}"

# sudo が必要な操作 (ユーザ作成・パスワード設定) は、root ならそのまま、非 root なら
# sudo を介して実行する。
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "==> openssh-server を用意"
if ! command -v sshd >/dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
  $SUDO apt-get update -y
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server
fi
SSHD_BIN="$(command -v sshd || echo /usr/sbin/sshd)"

echo "==> 鍵とユーザを準備 ($SSH_DIR)"
rm -rf "$SSH_DIR"
mkdir -p "$SSH_DIR"
# ホスト鍵 (sshd 用) とクライアント鍵 (鍵認証テスト用) を生成。
ssh-keygen -t ed25519 -f "$SSH_DIR/ssh_host_ed25519_key" -N "" -q
ssh-keygen -t ed25519 -f "$SSH_DIR/client_key" -N "" -q

echo "==> テストユーザ $SSH_USER を作成"
if ! id "$SSH_USER" >/dev/null 2>&1; then
  $SUDO useradd -m -s /bin/bash "$SSH_USER"
fi
echo "$SSH_USER:$SSH_PASS" | $SUDO chpasswd

# 鍵認証用に authorized_keys を配置 (所有者・パーミッションは sshd の要件に合わせる)。
USER_HOME="$(eval echo "~$SSH_USER")"
$SUDO mkdir -p "$USER_HOME/.ssh"
$SUDO cp "$SSH_DIR/client_key.pub" "$USER_HOME/.ssh/authorized_keys"
$SUDO chown -R "$SSH_USER:$SSH_USER" "$USER_HOME/.ssh"
$SUDO chmod 700 "$USER_HOME/.ssh"
$SUDO chmod 600 "$USER_HOME/.ssh/authorized_keys"

echo "==> sshd_config を書き出し"
cat > "$SSH_DIR/sshd_config" <<EOF
Port $SSH_PORT
ListenAddress 127.0.0.1
HostKey $SSH_DIR/ssh_host_ed25519_key
PidFile $SSH_DIR/sshd.pid
PasswordAuthentication yes
PubkeyAuthentication yes
PermitRootLogin no
UsePAM yes
AllowTcpForwarding yes
PermitTTY no
AllowUsers $SSH_USER
EOF

echo "==> sshd を起動 (127.0.0.1:$SSH_PORT)"
$SUDO mkdir -p /run/sshd
$SUDO "$SSHD_BIN" -f "$SSH_DIR/sshd_config" -E "$SSH_DIR/sshd.log"

# 起動を待ち、待ち受けを確認。
for _ in $(seq 1 10); do
  if grep -q "Server listening" "$SSH_DIR/sshd.log" 2>/dev/null; then
    break
  fi
  sleep 0.3
done
cat "$SSH_DIR/sshd.log" || true

SSH_URL="ssh://$SSH_USER:$SSH_PASS@127.0.0.1:$SSH_PORT"
SSH_KEY="$SSH_DIR/client_key"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "NOOBDB_TEST_SSH_URL=$SSH_URL" >> "$GITHUB_ENV"
  echo "NOOBDB_TEST_SSH_KEY=$SSH_KEY" >> "$GITHUB_ENV"
  echo "==> $GITHUB_ENV に NOOBDB_TEST_SSH_URL / NOOBDB_TEST_SSH_KEY を追記しました"
else
  echo "export NOOBDB_TEST_SSH_URL=$SSH_URL"
  echo "export NOOBDB_TEST_SSH_KEY=$SSH_KEY"
fi
