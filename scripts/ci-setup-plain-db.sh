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
# レプリケーション監視 (#2209) の統合テスト用に、PostgreSQL は pg_basebackup -R のストリーミング
# スタンバイ (primary → standby → cascade の 2 段) を、MySQL は 2 台目の mysqld を
# CHANGE REPLICATION SOURCE TO でレプリカにして立てる。接続 URL は $GITHUB_ENV へ書き出す
# (NOOBDB_TEST_POSTGRES_STANDBY_URL / NOOBDB_TEST_POSTGRES_CASCADE_URL / NOOBDB_TEST_MYSQL_REPLICA_URL。
# 未設定のテストは skip する)。
#
# ローカル検証時は PLAIN_DIR / MYSQL_PORT / PG_PORT / PG_STANDBY_PORT / PG_CASCADE_PORT /
# MYSQL_REPLICA_PORT を上書きできる。
set -euo pipefail

PLAIN_DIR="${PLAIN_DIR:-/tmp/noobdb-plaintest}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
PG_PORT="${PG_PORT:-5432}"
# 5433 は TLS 版 PostgreSQL (scripts/ci-setup-tls-db.sh) が使う。
PG_STANDBY_PORT="${PG_STANDBY_PORT:-5434}"
PG_CASCADE_PORT="${PG_CASCADE_PORT:-5435}"
# 3307 は TLS 版 MySQL が使う。
MYSQL_REPLICA_PORT="${MYSQL_REPLICA_PORT:-3308}"
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

# レプリカ用 datadir の初期化 (数秒かかる) は、ソースの起動や PostgreSQL の準備と重ねる。
echo "==> MySQL レプリカのデータディレクトリを初期化"
mkdir -p "$PLAIN_DIR/mysql-replica-data"
"$MYSQLD_BIN" --no-defaults --initialize-insecure \
  --datadir="$PLAIN_DIR/mysql-replica-data" \
  --log-error="$PLAIN_DIR/mysqld-replica-init.log"

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
host  replication all 127.0.0.1/32 scram-sha-256
HBA

echo "==> postgres を起動 (127.0.0.1:$PG_PORT)"
"$PG_BINDIR/pg_ctl" -D "$PLAIN_DIR/pg-data" -l "$PLAIN_DIR/postgres.log" -w -t 60 start
"$PG_BINDIR/psql" -h "$PLAIN_DIR" -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
ALTER USER postgres WITH PASSWORD '$PG_PASSWORD';
SQL
"$PG_BINDIR/psql" -h "$PLAIN_DIR" -p "$PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE testdb"

# ---- ストリーミングスタンバイ (#2209): primary → standby → cascade ----
# pg_basebackup -R は standby.signal と primary_conninfo (パスワード込み) を書く。
# 設定ファイルは primary のものがコピーされるので、ポートだけ pg_ctl -o で上書きする。
# standby は hot_standby (既定) なので読み取り接続できる。
pg_wait_streaming() {
  # $1: 送信側のポート。streaming の walsender が 1 本になるまで待つ。
  local n=""
  for _ in $(seq 1 60); do
    n="$(PGPASSWORD="$PG_PASSWORD" "$PG_BINDIR/psql" -h 127.0.0.1 -p "$1" -U postgres -d postgres -tA \
      -c "SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming'" 2>/dev/null || true)"
    if [ "$n" = "1" ]; then return 0; fi
    sleep 0.5
  done
  echo "!! ポート $1 の streaming が 30 秒以内に確立しませんでした" >&2
  tail -n 20 "$PLAIN_DIR"/*.log >&2 || true
  return 1
}
start_standby() {
  # $1: 名前, $2: 上流のポート, $3: 自分のポート
  PGPASSWORD="$PG_PASSWORD" "$PG_BINDIR/pg_basebackup" -h 127.0.0.1 -p "$2" -U postgres \
    -D "$PLAIN_DIR/$1-data" -R -X stream -c fast
  "$PG_BINDIR/pg_ctl" -D "$PLAIN_DIR/$1-data" -l "$PLAIN_DIR/$1.log" -w -t 60 -o "-p $3" start
  pg_wait_streaming "$2"
}
echo "==> PostgreSQL スタンバイを起動 (standby: $PG_STANDBY_PORT, cascade: $PG_CASCADE_PORT)"
start_standby pg-standby "$PG_PORT" "$PG_STANDBY_PORT"
start_standby pg-cascade "$PG_STANDBY_PORT" "$PG_CASCADE_PORT"

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
# ---- MySQL レプリカ (#2209) ----
# ソースは MySQL 8.0 の既定 (binlog 有効・server_id=1) のまま。レプリカは現在位置から追従し、
# 他の統合テストが書く testdb の DDL / DML でレプリカの SQL スレッドが止まらないよう、
# 専用 DB (noobdb_repl_probe) だけを複製対象にする。
echo "==> mysqld レプリカを起動 (127.0.0.1:$MYSQL_REPLICA_PORT)"
"$MYSQLD_BIN" --no-defaults \
  --datadir="$PLAIN_DIR/mysql-replica-data" \
  --socket="$PLAIN_DIR/mysql-replica.sock" \
  --port="$MYSQL_REPLICA_PORT" \
  --mysqlx=OFF \
  --bind-address=127.0.0.1 \
  --pid-file="$PLAIN_DIR/mysqld-replica.pid" \
  --server-id=2 \
  --report-host=127.0.0.1 \
  --report-port="$MYSQL_REPLICA_PORT" \
  --skip-log-bin \
  --init-file="$PLAIN_DIR/mysql-init.sql" \
  --replicate-wild-do-table='noobdb_repl_probe.%' \
  --log-error="$PLAIN_DIR/mysqld-replica.log" &
disown
replica_ready=0
for _ in $(seq 1 120); do
  if grep -q "ready for connections" "$PLAIN_DIR/mysqld-replica.log" 2>/dev/null; then
    replica_ready=1
    break
  fi
  sleep 0.5
done
if [ "$replica_ready" -ne 1 ]; then
  echo "!! mysqld (replica) が 60 秒以内に ready になりませんでした" >&2
  cat "$PLAIN_DIR/mysqld-replica.log" >&2 || true
  exit 1
fi
MYSQL_SRC=(mysql --no-defaults --protocol=socket --socket="$PLAIN_DIR/mysql.sock" -uroot -N -B)
MYSQL_REP=(mysql --no-defaults --protocol=socket --socket="$PLAIN_DIR/mysql-replica.sock" -uroot -B)
# 8.4 以降は SHOW BINARY LOG STATUS (SHOW MASTER STATUS は廃止)。
read -r BINLOG_FILE BINLOG_POS _ < <("${MYSQL_SRC[@]}" -e "SHOW MASTER STATUS" 2>/dev/null \
  || "${MYSQL_SRC[@]}" -e "SHOW BINARY LOG STATUS")
"${MYSQL_REP[@]}" <<SQL
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST='127.0.0.1', SOURCE_PORT=$MYSQL_PORT,
  SOURCE_USER='root', SOURCE_PASSWORD='$MYSQL_ROOT_PASSWORD',
  SOURCE_LOG_FILE='$BINLOG_FILE', SOURCE_LOG_POS=$BINLOG_POS,
  GET_SOURCE_PUBLIC_KEY=1;
START REPLICA;
SQL
for _ in $(seq 1 60); do
  running="$("${MYSQL_REP[@]}" -e "SHOW REPLICA STATUS\\G" 2>/dev/null | awk '/Replica_(IO|SQL)_Running:/ && $2=="Yes"' | wc -l)"
  if [ "$running" = "2" ]; then break; fi
  sleep 0.5
done
if [ "$running" != "2" ]; then
  echo "!! MySQL レプリカの IO / SQL スレッドが起動しませんでした" >&2
  "${MYSQL_REP[@]}" -e "SHOW REPLICA STATUS\\G" >&2 || true
  exit 1
fi

# テストへ渡す接続情報。CI 以外 (GITHUB_ENV 無し) では標準出力に出すだけ。
PG_STANDBY_URL="postgres://postgres:$PG_PASSWORD@127.0.0.1:$PG_STANDBY_PORT/testdb"
PG_CASCADE_URL="postgres://postgres:$PG_PASSWORD@127.0.0.1:$PG_CASCADE_PORT/testdb"
MYSQL_REPLICA_URL="mysql://root:$MYSQL_ROOT_PASSWORD@127.0.0.1:$MYSQL_REPLICA_PORT/testdb"
if [ -n "${GITHUB_ENV:-}" ]; then
  {
    echo "NOOBDB_TEST_POSTGRES_STANDBY_URL=$PG_STANDBY_URL"
    echo "NOOBDB_TEST_POSTGRES_CASCADE_URL=$PG_CASCADE_URL"
    echo "NOOBDB_TEST_MYSQL_REPLICA_URL=$MYSQL_REPLICA_URL"
  } >> "$GITHUB_ENV"
  echo "==> \$GITHUB_ENV にレプリケーション用の NOOBDB_TEST_* を追記しました"
else
  echo "NOOBDB_TEST_POSTGRES_STANDBY_URL=$PG_STANDBY_URL"
  echo "NOOBDB_TEST_POSTGRES_CASCADE_URL=$PG_CASCADE_URL"
  echo "NOOBDB_TEST_MYSQL_REPLICA_URL=$MYSQL_REPLICA_URL"
fi

echo "--- mysqld.log (tail) ---"
tail -n 10 "$PLAIN_DIR/mysqld.log" || true
echo "--- postgres.log (tail) ---"
tail -n 10 "$PLAIN_DIR/postgres.log" || true
