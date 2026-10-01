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

## オブジェクト依存検索 / 影響分析 (#1027)

「このテーブル / 列を DROP・RENAME したら何が壊れるか」を、ビュー・ルーチン・
トリガーの定義本文と保存済みスニペットから探すボトムパネル (`whereUsed` タブ)。

- **新しい IPC は無い。** 既存の `list_schema_objects` → `get_object_definition`
  (同時 4 本、進捗表示・キャンセル可) と App が保持するスニペット一覧を合成するだけ。
- 判定は純モジュール `components/whereUsed.ts`。`dangerousSql.ts` の
  `maskLiterals` をそのまま再利用し (挙動は変えない)、引用識別子の中身と
  PostgreSQL のドル引用本体 (関数本文) だけを書き戻してから識別子トークンを照合する。
  境界規則 (部分一致しない・大小無視・引用解釈・スキーマ修飾・列の別名解決) は
  同ファイル冒頭の JSDoc。判定に迷う列参照は捨てずに `possible` (候補) で残す。
- ドライバ別の取得可否は `WHERE_USED_KIND_SUPPORT` (SQLite はビュー/トリガーのみ)。
  取れない種別・取得失敗・空の本文は UI で明示。
- 入口: スキーマツリーの右クリック (テーブル / ビュー / 列)、コマンドパレット。
  結果から既存の定義ビューア (`handleOpenObjectDefinition`) / スニペットへ遷移する。

## ライブクエリ・インスペクタ (#746)

`commands/inspector.rs` の 4 コマンド。

| コマンド | 内容 |
|---|---|
| `query_stats_support` | 前提可否プローブ。MySQL は `performance_schema` / consumer の状態、PostgreSQL は `pg_stat_statements` の有無・可読性を調べる |
| `sample_live_queries` | 実行中/直近のステートメントをポーリングで取得 |
| `start_statement_recording` | 記録開始。digest 累積スナップショットをセッション状態に baseline として保持 (#1259) |
| `sample_statement_delta` | baseline からの digest 差分 (calls > 0 の行) と N+1 目安。`refresh: false` は前回取得分を `cumulative` 切替で再計算するだけ (#1259) |

- **使えない機能には理由コードを付けて返します** (`QueryStatsSupport` の
  `live_tail_reason` / `statements_reason`)。フロントがコードを有効化手順つきの
  ヘルプ文言にマップし、**黙って空にしません** — `performance_schema` 無効時に
  プロセス一覧が空になっていた #587 の教訓です。
- 取得はすべて読み取り SELECT のポーリングで、**サーバ設定は変更しません**。
- `LiveQuery.key` はポーリング横断の重複排除キー (MySQL は `THREAD_ID:EVENT_ID`、
  PostgreSQL は `pid:query_start エポック`)。自セッション由来は除外しますが、
  同一プールの別物理接続はエンジンから区別できないためベストエフォートです
  (`ProcessInfo::is_self` と同じ限界)。
- SQLite は未対応 (`unsupported_driver` 縮退)。
- **差分集計・指紋化はバックエンド (#1259)**: `db/inspector.rs` の `InspectorState` が
  `Session::inspector` にセッション単位で baseline / 直前 / 最新スナップショットと
  送信済み digest を保持し、引き算・N+1 レート目安・総時間降順の整列を行う。
  **サーバ側カウンタはリセットしない** (権限不要) 設計は従来どおりで、引き算を
  クライアントから Rust へ移しただけ。SQL 本文 (`fingerprint`) は digest の初出時だけ
  返し、フロントは `digest + database` キーでキャッシュする (`start_statement_recording`
  で送信済み集合がリセットされる)。状態は `Session` のフィールドなので切断・再接続で
  破棄される。ライブテールの同型クエリキーも `sample_live_queries` が
  `LiveQuery.fingerprint` として返す (`normalize_sql_fingerprint`)。旧 JS 実装を oracle に
  生成したゴールデンベクタ `src/__tests__/fixtures/sqlFingerprintVectors.json` で出力の
  一致を Rust のテストが固定する。正規化規則を変えるときはこの JSON に境界ケースを追記する。
- UI: `components/QueryInspectorPanel.tsx`、純ロジック (N+1 窓判定・テールのマージ/
  フィルタ) は `components/queryInspector.ts`。

## サーバ情報 / メトリクス (#563)

`commands/server.rs` の `server_info` (バージョン + 主要設定変数) と `server_metrics`。
`SHOW VARIABLES` / `pg_settings` / `PRAGMA` など**書き込みを伴わない経路のみ**を
使います。アクティブ接続は既存のプロセスモニタ (`list_processes`) が担うため
重複させません。SQLite では `server_metrics` は未実装 (`unsupported_driver`)。
UI: `ServerInfoPanel.tsx` / `ServerMetricsPanel.tsx`、純ロジックは `serverMetrics.ts`。

## スキーマドリフトのタイムライン (#736)

取得・保存・差分計算はすべて Rust の `schema_drift` モジュール (#1260) で完結します
(構成は `timelapse/` と同じ `mod.rs` + `store.rs`、保存先は
`<data_dir>/schema_drift.sqlite`)。`schema_drift_capture` が
`Connection::columns_for_database` / `indexes_for_database` (DB 全体を各 1 クエリ) で
スナップショットを取り、テーブル名順に正規化 → FNV-1a フィンガープリント → 直前世代と
同一なら何もせず、異なれば追加して 20 世代でローテーション → `compute_schema_diff` +
`diff_indexes` で前世代との変化サマリを作って返します (フロントへはサマリだけが渡る)。
1 世代が 8 MiB を超えるときは中身の保存を省略し `omitted` を立てます (フィンガープリントは
全内容から計算)。`schema_drift_list` / `schema_drift_compare` はセッション不要で、
パネルの世代一覧と 2 世代比較を担います。キャッシュは経由せず常にドライバへ直接
問い合わせます (変化の検知が目的のため)。

旧実装の localStorage 世代は、プロファイルを選んだ時 (または取得時) に
`migrateLegacySchemaDrift` が `schema_drift_import_legacy` へ一度だけ渡して取り込み、
成功したらキーを削除します (Rust 側でフィンガープリントを計算し直すので、移行直後の
取得が余計な世代を積まない)。
UI: `components/SchemaDriftPanel.tsx`、フロントに残る整形・移行ロジックは `schemaDrift.ts`。

実行計画のウォッチ (#743) は別機能で、`components/PlanWatchPanel.tsx` /
`planDiff.ts` / `planWatch.ts` が担います (`noobdb-frontend` スキル参照)。
