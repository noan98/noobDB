#!/usr/bin/env bash
# 実 TLS サーバに対する統合テスト (#520 の既知ギャップ、#795) 用に、自己署名 CA +
# サーバ証明書を生成し、TLS 必須の MySQL / PostgreSQL インスタンスを別ポートで
# 起動するスクリプト。
#
# 既存の `rust (test)` ジョブの MySQL/PostgreSQL サービスコンテナ (3306/5432、平文)
# はそのまま残し、本スクリプトは**別ポート** (既定 3307/5433) に TLS 必須の別
# インスタンスを apt パッケージ (mysql-server / postgresql、GitHub Actions の
# ubuntu-latest ランナーには既定でプリインストール済み) で直接構成する。
#
# サービスコンテナ (`services:`) ではなくこの方式を選んだ理由:
#   - サービスコンテナはジョブの他のどのステップよりも前に起動するため、証明書を
#     生成してからコンテナへ渡す手段がない (ボリュームで後からファイルを流し込んでも
#     mysqld/postgres は起動時にしか TLS 設定ファイルを読まない)。
#   - `services:` の workflow 構文には `command:` (エントリポイント引数の上書き) が
#     無く、公式 postgres イメージへ `-c ssl=on -c ssl_cert_file=...` のような
#     起動引数を渡す手段が存在しない。
# SSH トンネル統合テスト (#331, scripts/ci-setup-sshd.sh) がサービスコンテナに
# 頼らず apt の openssh-server を直接構成しているのと同じ発想で、ローカルでも
# 同じ手順を再現・検証できる。
#
# 最後にテストが参照する環境変数を $GITHUB_ENV に追記する (CI 以外で実行した場合は
# 標準出力に export 文を出す):
#   NOOBDB_TEST_MYSQL_TLS_URL    (例: mysql://root:rootpw@127.0.0.1:3307/testdb)
#   NOOBDB_TEST_POSTGRES_TLS_URL (例: postgres://postgres:postgres@127.0.0.1:5433/testdb)
#   NOOBDB_TEST_TLS_CA           (両サーバの証明書を発行した CA の PEM パス。共通)
#
# ローカル検証時は TLS_DIR / MYSQL_TLS_PORT / PG_TLS_PORT を上書きできる。
set -euo pipefail

TLS_DIR="${TLS_DIR:-/tmp/noobdb-tlstest}"
MYSQL_TLS_PORT="${MYSQL_TLS_PORT:-3307}"
PG_TLS_PORT="${PG_TLS_PORT:-5433}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-rootpw}"
PG_PASSWORD="${PG_PASSWORD:-postgres}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "==> 証明書一式を生成 ($TLS_DIR)"
rm -rf "$TLS_DIR"
mkdir -p "$TLS_DIR"

# 共通 CA (両サーバの証明書をこの CA で署名し、テストからは 1 つの CA パスだけを
# 参照すればよいようにする)。basicConstraints=CA:TRUE を明示しないと環境の既定
# openssl.cnf 次第で CA フラグが立たず、クライアント側のチェーン検証で
# 「not a CA」として拒否されることがあるため -addext で明示する。
openssl genrsa -out "$TLS_DIR/ca-key.pem" 2048 2>/dev/null
openssl req -new -x509 -nodes -days 3650 -key "$TLS_DIR/ca-key.pem" \
  -out "$TLS_DIR/ca.pem" -subj "/CN=noobDB Test CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

# サーバ証明書を 1 枚発行する (127.0.0.1 / localhost を SAN に含める。verify_full の
# ホスト名検証がこの SAN を見る)。
gen_server_cert() {
  local name="$1"
  openssl genrsa -out "$TLS_DIR/${name}-key.pem" 2048 2>/dev/null
  openssl req -new -key "$TLS_DIR/${name}-key.pem" -out "$TLS_DIR/${name}.csr" \
    -subj "/CN=127.0.0.1" 2>/dev/null
  cat > "$TLS_DIR/${name}-ext.cnf" <<'EXT'
subjectAltName = IP:127.0.0.1,DNS:localhost
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EXT
  openssl x509 -req -days 3650 -in "$TLS_DIR/${name}.csr" \
    -CA "$TLS_DIR/ca.pem" -CAkey "$TLS_DIR/ca-key.pem" -CAcreateserial \
    -out "$TLS_DIR/${name}-cert.pem" -extfile "$TLS_DIR/${name}-ext.cnf" 2>/dev/null
}
gen_server_cert mysql-server
gen_server_cert pg-server

chmod 644 "$TLS_DIR"/ca.pem "$TLS_DIR"/*-cert.pem
chmod 600 "$TLS_DIR"/*-key.pem

# ============================== MySQL ==============================
echo "==> mysql-server を用意"
if ! command -v mysqld >/dev/null 2>&1 && [ ! -x /usr/sbin/mysqld ]; then
  $SUDO apt-get update -y
  $SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server
fi
MYSQLD_BIN="$(command -v mysqld || echo /usr/sbin/mysqld)"

# Ubuntu の mysql-server パッケージには mysqld を /var/lib/mysql 等の既定パスに
# 閉じ込める AppArmor プロファイルが付属することがある。本スクリプトはカスタムの
# datadir/証明書パス ($TLS_DIR 配下) を使うため、プロファイルを complain モードに
# 落として (エンフォースを止めて) アクセスを通す。プロファイル自体が存在しない
# 環境では何もしないので副作用はない。
$SUDO aa-complain /usr/sbin/mysqld >/dev/null 2>&1 || true

echo "==> MySQL データディレクトリを初期化"
rm -rf "$TLS_DIR/mysql-data"
mkdir -p "$TLS_DIR/mysql-data"
"$MYSQLD_BIN" --no-defaults --initialize-insecure \
  --datadir="$TLS_DIR/mysql-data" \
  --log-error="$TLS_DIR/mysqld-init.log"

cat > "$TLS_DIR/mysql-init.sql" <<EOF
CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '$MYSQL_ROOT_PASSWORD';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
CREATE DATABASE IF NOT EXISTS testdb;
FLUSH PRIVILEGES;
EOF

echo "==> mysqld を起動 (127.0.0.1:$MYSQL_TLS_PORT, TLS 必須)"
"$MYSQLD_BIN" --no-defaults \
  --datadir="$TLS_DIR/mysql-data" \
  --socket="$TLS_DIR/mysql.sock" \
  --port="$MYSQL_TLS_PORT" \
  --bind-address=127.0.0.1 \
  --pid-file="$TLS_DIR/mysqld.pid" \
  --ssl-ca="$TLS_DIR/ca.pem" \
  --ssl-cert="$TLS_DIR/mysql-server-cert.pem" \
  --ssl-key="$TLS_DIR/mysql-server-key.pem" \
  --require-secure-transport=ON \
  --init-file="$TLS_DIR/mysql-init.sql" \
  --log-error="$TLS_DIR/mysqld.log" &
disown

for _ in $(seq 1 60); do
  if grep -q "ready for connections" "$TLS_DIR/mysqld.log" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
echo "--- mysqld.log (tail) ---"
tail -n 20 "$TLS_DIR/mysqld.log" || true

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
rm -rf "$TLS_DIR/pg-data"
"$PG_BINDIR/initdb" -D "$TLS_DIR/pg-data" -U postgres --auth=trust >/dev/null

cp "$TLS_DIR/ca.pem" "$TLS_DIR/pg-server-cert.pem" "$TLS_DIR/pg-server-key.pem" "$TLS_DIR/pg-data/"
chmod 600 "$TLS_DIR/pg-data/pg-server-key.pem"

cat >> "$TLS_DIR/pg-data/postgresql.conf" <<EOF
port = $PG_TLS_PORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$TLS_DIR'
ssl = on
ssl_ca_file = 'ca.pem'
ssl_cert_file = 'pg-server-cert.pem'
ssl_key_file = 'pg-server-key.pem'
EOF

# ローカル (unix socket) はパスワード設定用に trust のまま残し、TCP 経由は SSL 必須
# + パスワード認証にする (secure_transport 相当。plaintext TCP 接続は拒否される)。
cat > "$TLS_DIR/pg-data/pg_hba.conf" <<EOF
local   all all                trust
hostssl all all 127.0.0.1/32   scram-sha-256
hostssl all all ::1/128        scram-sha-256
EOF

echo "==> postgres を起動 (127.0.0.1:$PG_TLS_PORT, TLS 必須)"
"$PG_BINDIR/pg_ctl" -D "$TLS_DIR/pg-data" -l "$TLS_DIR/postgres.log" -w -t 60 start

"$PG_BINDIR/psql" -h "$TLS_DIR" -p "$PG_TLS_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 <<EOF
ALTER USER postgres WITH PASSWORD '$PG_PASSWORD';
EOF
if ! "$PG_BINDIR/psql" -h "$TLS_DIR" -p "$PG_TLS_PORT" -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = 'testdb'" | grep -q 1; then
  "$PG_BINDIR/psql" -h "$TLS_DIR" -p "$PG_TLS_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE testdb"
fi

echo "--- postgres.log (tail) ---"
tail -n 20 "$TLS_DIR/postgres.log" || true

# ============================== env 出力 ==============================
MYSQL_TLS_URL="mysql://root:$MYSQL_ROOT_PASSWORD@127.0.0.1:$MYSQL_TLS_PORT/testdb"
POSTGRES_TLS_URL="postgres://postgres:$PG_PASSWORD@127.0.0.1:$PG_TLS_PORT/testdb"
CA_PATH="$TLS_DIR/ca.pem"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "NOOBDB_TEST_MYSQL_TLS_URL=$MYSQL_TLS_URL" >> "$GITHUB_ENV"
  echo "NOOBDB_TEST_POSTGRES_TLS_URL=$POSTGRES_TLS_URL" >> "$GITHUB_ENV"
  echo "NOOBDB_TEST_TLS_CA=$CA_PATH" >> "$GITHUB_ENV"
  echo "==> \$GITHUB_ENV に NOOBDB_TEST_MYSQL_TLS_URL / NOOBDB_TEST_POSTGRES_TLS_URL / NOOBDB_TEST_TLS_CA を追記しました"
else
  echo "export NOOBDB_TEST_MYSQL_TLS_URL=$MYSQL_TLS_URL"
  echo "export NOOBDB_TEST_POSTGRES_TLS_URL=$POSTGRES_TLS_URL"
  echo "export NOOBDB_TEST_TLS_CA=$CA_PATH"
fi
