#!/usr/bin/env bash
# 平文接続の MySQL / PostgreSQL 統合テスト (tests/mysql_integration.rs / postgres_integration.rs)
# 用に、ubuntu-latest ランナーにプリインストール済みのサーバを直接起動するスクリプト。
#
# 以前は `services:` のコンテナ (mysql:8.0 / postgres:16) を使っていたが、イメージの
# pull とヘルスチェック待ちでジョブ開始時に約 30 秒かかっていた。ランナー同梱のバイナリを
# 使えばこの待ちが消え、他のセットアップ (sshd / TLS DB / テストのビルド) と重ねられる。
# TLS 版 (scripts/ci-setup-tls-db.sh) と同じ作り方で、ポートと認証だけが違う
# (3306 / 5432、TLS なし)。接続情報は従来のコンテナと同じにしてあり、環境変数は
# ワークフロー側 (NOOBDB_TEST_MYSQL_URL / NOOBDB_TEST_POSTGRES_URL) がそのまま持つ。
#
# ローカル検証時は PLAIN_DIR / MYSQL_PORT / PG_PORT を上書きできる。
set -euo pipefail

PLAIN_DIR="${PLAIN_DIR:-/tmp/noobdb-plaintest}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
PG_PORT="${PG_PORT:-5432}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-rootpw}"
PG_PASSWORD="${PG_PASSWORD:-postgres}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

rm -rf "$PLAIN_DIR"
mkdir -p "$PLAIN_DIR"

# ============================== MySQL ==============================
echo "==> mysql-server を用意"
if ! command -v mysqld >/dev/null 2>&1 && [ ! -x /usr/sbin/mysqld ]; then
  $SUDO apt-get update -y
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server
fi
MYSQLD_BIN="$(command -v mysqld || echo /usr/sbin/mysqld)"
# カスタム datadir を使うため、AppArmor のプロファイルがあれば complain に落とす
# (TLS 版スクリプトと同じ理由)。
$SUDO aa-complain /usr/sbin/mysqld >/dev/null 2>&1 || true

echo "==> MySQL データディレクトリを初期化"
mkdir -p "$PLAIN_DIR/mysql-data"
"$MYSQLD_BIN" --no-defaults --initialize-insecure \
  --datadir="$PLAIN_DIR/mysql-data" \
  --log-error="$PLAIN_DIR/mysqld-init.log"

cat > "$PLAIN_DIR/mysql-init.sql" <<SQL
CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '$MYSQL_ROOT_PASSWORD';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
CREATE DATABASE IF NOT EXISTS testdb;
FLUSH PRIVILEGES;
SQL

echo "==> mysqld を起動 (127.0.0.1:$MYSQL_PORT)"
"$MYSQLD_BIN" --no-defaults \
  --datadir="$PLAIN_DIR/mysql-data" \
  --socket="$PLAIN_DIR/mysql.sock" \
  --port="$MYSQL_PORT" \
  --bind-address=127.0.0.1 \
  --pid-file="$PLAIN_DIR/mysqld.pid" \
  --init-file="$PLAIN_DIR/mysql-init.sql" \
  --log-error="$PLAIN_DIR/mysqld.log" &
disown

# ============================== PostgreSQL ==============================
echo "==> postgresql を用意"
PG_BINDIR="$(pg_config --bindir 2>/dev/null || true)"
if [ -z "$PG_BINDIR" ] || [ ! -x "$PG_BINDIR/initdb" ]; then
  PG_BINDIR="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$PG_BINDIR" ] || [ ! -x "$PG_BINDIR/initdb" ]; then
  $SUDO apt-get update -y
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql
  PG_BINDIR="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
fi

echo "==> PostgreSQL データディレクトリを初期化"
"$PG_BINDIR/initdb" -D "$PLAIN_DIR/pg-data" -U postgres --auth=trust >/dev/null
cat >> "$PLAIN_DIR/pg-data/postgresql.conf" <<CONF
port = $PG_PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$PLAIN_DIR'
CONF
# unix socket はパスワード設定用に trust、TCP はパスワード認証 (従来のコンテナと同じ)。
cat > "$PLAIN_DIR/pg-data/pg_hba.conf" <<HBA
local all all              trust
host  all all 127.0.0.1/32 scram-sha-256
host  all all ::1/128      scram-sha-256
HBA

echo "==> postgres を起動 (127.0.0.1:$PG_PORT)"
"$PG_BINDIR/pg_ctl" -D "$PLAIN_DIR/pg-data" -l "$PLAIN_DIR/postgres.log" -w -t 60 start
"$PG_BINDIR/psql" -h "$PLAIN_DIR" -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
ALTER USER postgres WITH PASSWORD '$PG_PASSWORD';
SQL
"$PG_BINDIR/psql" -h "$PLAIN_DIR" -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE testdb"

# mysqld の起動完了を待つ (PostgreSQL の初期化と重ねたので、ここでは短い待ちで済む)。
mysql_ready=0
for _ in $(seq 1 120); do
  if grep -q "ready for connections" "$PLAIN_DIR/mysqld.log" 2>/dev/null; then
    mysql_ready=1
    break
  fi
  sleep 0.5
done
if [ "$mysql_ready" -ne 1 ]; then
  # タイムアウト時はここで確実に fail させる (サーバ不在への接続失敗という別の理由で
  # テストが落ちて原因が分かりにくくなるのを避ける)。
  echo "!! mysqld が 60 秒以内に ready になりませんでした" >&2
  cat "$PLAIN_DIR/mysqld.log" >&2 || true
  exit 1
fi
echo "--- mysqld.log (tail) ---"
tail -n 10 "$PLAIN_DIR/mysqld.log" || true
echo "--- postgres.log (tail) ---"
tail -n 10 "$PLAIN_DIR/postgres.log" || true
