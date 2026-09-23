#!/usr/bin/env bash
# MSSQL 統合テスト (src-tauri/tests/mssql_integration.rs、#920) 用の SQL Server を
# 準備するスクリプト。
#
# CI の `rust (test)` ジョブでは SQL Server 2022 をサービスコンテナ (`mssql`) として
# 起動しており、このスクリプトはそのコンテナの中の sqlcmd を `docker exec` で叩いて
# 1. サーバがクエリを受け付けるまで待ち (サービスの healthcheck に加えた二重の保険)、
# 2. テスト用データベース (既定 `testdb`) を作成し、
# 3. テストが参照する NOOBDB_TEST_MSSQL_URL を $GITHUB_ENV に追記する
#    (CI 以外で実行した場合は標準出力に export 文を出す)。
#
# テスト用 DB を作る理由: 接続 URL の database はログイン時の既定 DB になるため、
# 存在しないと接続そのものが失敗する (MySQL / PostgreSQL のサービスコンテナは
# MYSQL_DATABASE / POSTGRES_DB で自動作成されるが、SQL Server のイメージには同等の
# 環境変数が無い)。
#
# ローカル検証時は MSSQL_CONTAINER (コンテナ名/ID) / MSSQL_SA_PASSWORD /
# MSSQL_DB / MSSQL_PORT を上書きできる。例:
#   docker run -d --name noobdb-mssql -e ACCEPT_EULA=Y \
#     -e MSSQL_SA_PASSWORD=NoobDB_Test_Pw1 -p 1433:1433 \
#     mcr.microsoft.com/mssql/server:2022-latest
#   MSSQL_CONTAINER=noobdb-mssql bash scripts/ci-setup-mssql.sh
set -euo pipefail

MSSQL_CONTAINER="${MSSQL_CONTAINER:?MSSQL_CONTAINER (service container name or id) is required}"
MSSQL_SA_PASSWORD="${MSSQL_SA_PASSWORD:-NoobDB_Test_Pw1}"
MSSQL_DB="${MSSQL_DB:-testdb}"
MSSQL_PORT="${MSSQL_PORT:-1433}"
# 起動待ちの上限 (秒)。SQL Server の初回起動 (システム DB のアップグレード等) は
# 数十秒かかることがある。
MSSQL_WAIT_SECS="${MSSQL_WAIT_SECS:-180}"

# 2022 のイメージは CU14 (2024) 以降 sqlcmd を mssql-tools18 に同梱しており、旧来の
# /opt/mssql-tools は無い。古いタグでも動くよう両方を探す。tools18 は既定で
# 暗号化 + 証明書検証を行うため、自己署名証明書を信頼する -C が要る。
find_sqlcmd() {
  local candidate
  for candidate in /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; do
    if docker exec "$MSSQL_CONTAINER" test -x "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

echo "==> SQL Server コンテナ ($MSSQL_CONTAINER) の sqlcmd を探す"
SQLCMD="$(find_sqlcmd)" || {
  echo "::error::sqlcmd が SQL Server コンテナ内に見つかりません (/opt/mssql-tools18 / /opt/mssql-tools)" >&2
  docker logs "$MSSQL_CONTAINER" 2>&1 | tail -n 50 >&2 || true
  exit 1
}
SQLCMD_FLAGS=(-S localhost -U sa -P "$MSSQL_SA_PASSWORD" -b)
case "$SQLCMD" in
  */mssql-tools18/*) SQLCMD_FLAGS+=(-C) ;;
esac
echo "    $SQLCMD"

run_sql() {
  docker exec "$MSSQL_CONTAINER" "$SQLCMD" "${SQLCMD_FLAGS[@]}" -Q "$1"
}

echo "==> SQL Server がクエリを受け付けるまで待機 (最大 ${MSSQL_WAIT_SECS} 秒)"
deadline=$(( $(date +%s) + MSSQL_WAIT_SECS ))
until run_sql "SET NOCOUNT ON; SELECT 1" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::SQL Server が ${MSSQL_WAIT_SECS} 秒以内に起動しませんでした" >&2
    docker logs "$MSSQL_CONTAINER" 2>&1 | tail -n 50 >&2 || true
    exit 1
  fi
  sleep 3
done

echo "==> テスト用データベース $MSSQL_DB を作成"
run_sql "SET NOCOUNT ON; IF DB_ID(N'$MSSQL_DB') IS NULL CREATE DATABASE [$MSSQL_DB];"
run_sql "SET NOCOUNT ON; SELECT name, collation_name FROM sys.databases WHERE name = N'$MSSQL_DB';"

MSSQL_URL="mssql://sa:${MSSQL_SA_PASSWORD}@127.0.0.1:${MSSQL_PORT}/${MSSQL_DB}"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "NOOBDB_TEST_MSSQL_URL=$MSSQL_URL" >> "$GITHUB_ENV"
  echo "==> \$GITHUB_ENV に NOOBDB_TEST_MSSQL_URL を追記しました"
else
  echo "export NOOBDB_TEST_MSSQL_URL='$MSSQL_URL'"
fi
