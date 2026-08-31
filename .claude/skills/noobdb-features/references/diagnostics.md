# 診断機能 (アドバイザ / インスペクタ / サーバ情報 / スキーマドリフト)

いずれも**読み取りの introspection のみ**で、`read_only` セッションでも許可されます。

## スキーマ健全性アドバイザ (#741)

**入力 (スキーマメタデータ) → 指摘リスト**の純関数として実装された、決定的な
ルールベースのスキーマ診断です。AI 非依存で誤検出しにくい機械的な検査のみを扱い、
コンテキスト依存の「提案」はしません。

- 純ロジックは `db/advisor.rs`、IPC ラッパーは `commands/advisor.rs`
  (`analyze_schema_health`)。命令の層がライブセッションからテーブル/カラム/
  インデックス/外部キーのメタデータと (縮退しうる) 統計を集めて純関数へ渡します。
- **バックエンドは散文を一切出しません。** 各指摘は安定した `RuleId` と、
  ローカライズされた説明文を組み立てるための構造化フィールド (`table` / `columns` /
  `context`) を持ち、フロントが `RuleId` をタイトル・説明テンプレートへマップします
  (`QueryStatsSupport` の理由コードと同じ発想)。
- `RuleId`: `FkMissingIndex` / `DuplicateIndex` / `RedundantIndex` /
  `MissingPrimaryKey` / `UnusedIndex` / `FkTypeMismatch` / `SqliteIntegerPkHint`。
  重要度は `Severity` (`High` / `Medium` / `Low`) で、フロントで semantic トークン
  (#664) に色分けされます。
- **修正 DDL は安全で一意に定まるルールについてのみ生成し、実行はしません**
  (エディタ挿入まで)。
- ビューは `schema_objects` の一覧で除外し、ベーステーブルのみを対象にします
  (PK 欠落ルールがビューで誤検出しないため)。メタデータ収集はテーブルごとに
  `columns` / `list_indexes` を 1 往復する N+1 ですが、明示実行のユーザ操作なので
  `compare_schema` と同じく許容しています。
- UI: `components/AdvisorPanel.tsx`、純ロジックのミラーは `components/advisor.ts`。

## ライブクエリ・インスペクタ (#746)

`commands/inspector.rs` の 3 コマンド。

| コマンド | 内容 |
|---|---|
| `query_stats_support` | 前提可否プローブ。MySQL は `performance_schema` / consumer の状態、PostgreSQL は `pg_stat_statements` の有無・可読性を調べる |
| `sample_live_queries` | 実行中/直近のステートメントをポーリングで取得 |
| `sample_statement_stats` | 集約済みのステートメント統計 |

- **使えない機能には理由コードを付けて返します** (`QueryStatsSupport` の
  `live_tail_reason` / `statements_reason`)。フロントがコードを有効化手順つきの
  ヘルプ文言にマップし、**黙って空にしません** — `performance_schema` 無効時に
  プロセス一覧が空になっていた #587 の教訓です。
- 取得はすべて読み取り SELECT のポーリングで、**サーバ設定は変更しません**。
- `LiveQuery.key` はポーリング横断の重複排除キー (MySQL は `THREAD_ID:EVENT_ID`、
  PostgreSQL は `pid:query_start エポック`)。自セッション由来は除外しますが、
  同一プールの別物理接続はエンジンから区別できないためベストエフォートです
  (`ProcessInfo::is_self` と同じ限界)。
- MSSQL / SQLite は未対応 (`unsupported_driver` 縮退)。
- UI: `components/QueryInspectorPanel.tsx`、純ロジックは `components/queryInspector.ts`。

## サーバ情報 / メトリクス (#563)

`commands/server.rs` の `server_info` (バージョン + 主要設定変数) と `server_metrics`。
`SHOW VARIABLES` / `pg_settings` / `PRAGMA` など**書き込みを伴わない経路のみ**を
使います。アクティブ接続は既存のプロセスモニタ (`list_processes`) が担うため
重複させません。MSSQL / SQLite では `server_metrics` は未実装 (`unsupported_driver`)。
UI: `ServerInfoPanel.tsx` / `ServerMetricsPanel.tsx`、純ロジックは `serverMetrics.ts`。

## スキーマドリフトのタイムライン (#736)

`commands/diff.rs::diff_schema_snapshots` は、**ライブセッションを介さずに** 2 つの
スキーマスナップショットを比較する `compute_schema_diff` への薄いパススルーです。

フロントが接続のたびに `list_tables` + `describe_table` で `TableColumns` の
スナップショット (`compare_schema` がライブに集めるのと同じもの) を `localStorage` へ
取り、任意の 2 世代を比較します — 接続直後に現在のスナップショットを直前の世代と
比べればドリフトを検出できます。`sync::generate_sync_sql` と同じく純粋・同期で、
両側を呼び出し側が渡すため `AppState` は不要です。
UI: `components/SchemaDriftPanel.tsx`、純ロジックは `schemaDrift.ts`。

実行計画のウォッチ (#743) は別機能で、`components/PlanWatchPanel.tsx` /
`planDiff.ts` / `planWatch.ts` が担います (`noobdb-frontend` スキル参照)。
