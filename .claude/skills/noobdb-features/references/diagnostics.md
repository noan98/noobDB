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
  `MissingPrimaryKey` / `UnusedIndex` / `FkTypeMismatch` / `SqliteIntegerPkHint` / `NullableForeignKey` /
  `OversizedVarchar` (MySQL のみ・長さ 1000 超) / `FloatForMoney` (金額らしい列名 + FLOAT/DOUBLE/REAL) /
  `SequenceExhaustion` (#2210: AUTO_INCREMENT / serial / IDENTITY / SQLite AUTOINCREMENT が型の上限の 50% 以上で `Medium`、80% 以上で `High`)。
  重要度は `Severity` (`High` / `Medium` / `Low`) で、フロントで semantic トークン
  (#664) に色分けされます。
- **採番の枯渇 (#2210)**: ドライバが `Connection::sequence_usage` で生の事実 (`SequenceUsage`: 払い出し済み最大値・
  シーケンスの `max_value`・`cycle`) だけを返し、上限 (型 / シーケンスの小さい方) と使用率は純ロジックが
  **u128 の整数演算**で出す (BIGINT UNSIGNED は JS の安全整数を超えるので `context` の数値は 10 進文字列)。
  取得元は MySQL `information_schema.TABLES.AUTO_INCREMENT` (統計キャッシュ `information_schema_stats_expiry` は `SET_VAR` が効かないので、プールから取った 1 接続で `SET SESSION` → SELECT → `DEFAULT` に戻す)、
  PostgreSQL `pg_sequences` + `pg_depend` (serial / identity)、SQLite `sqlite_sequence`。`CYCLE` は対象外。
  修正 DDL は `BIGINT` への型変更 (MySQL は COMMENT / INVISIBLE を付け直し、ZEROFILL 列は出さない。PostgreSQL は `ALTER SEQUENCE ... AS bigint NO MAXVALUE`) で、UI は
  `AlterCostNotice` (#1771) の書き換え・ロック注意を添える。取得に失敗したら `sequences_unreadable` でスキップ表示。
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

- 走査は Rust の **`find_where_used`** (#1261)。定義本文の取得 (PostgreSQL / SQLite は
  1 問い合わせで一括、MySQL は `SHOW CREATE` を並列 3 で個別取得) と識別子の照合、保存済み
  スニペット (接続プロファイルのスコープで絞り込み) の走査までをバックエンドが行い、ヒット位置
  だけを Channel で返す (進捗表示・`cancel_stream` によるキャンセル=途中結果つき)。
- 判定は `src-tauri/src/db/where_used.rs`。安全網と同じマスク (`mask_for_driver`) を
  再利用し (挙動は変えない)、引用識別子の中身と
  PostgreSQL のドル引用本体 (関数本文) だけを書き戻してから識別子トークンを照合する。
  境界規則 (部分一致しない・大小無視・引用解釈・スキーマ修飾・列の別名解決) は
  同ファイル冒頭のドキュメント。判定に迷う列参照は捨てずに `possible` (候補) で残す。
  位置・行内範囲・160 文字の切り詰めは旧 TS 実装と同じ UTF-16 コードユニット基準。
  旧 TS 実装は `src/__tests__/oracles/whereUsedOracle.ts` にオラクルとして残り、
  共有ゴールデン `whereUsedVectors.json` で Rust と突き合わせる。フロントの
  `components/whereUsed.ts` には並べ替え・強調区間の分割・縮退表示だけが残る。
- ドライバ別の取得可否は `where_used::supports_kind` (SQLite はビュー/トリガーのみ。UI の縮退表示は
  `unsupportedWhereUsedKinds`)。
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

## LISTEN / NOTIFY 監視 (#2019)

PostgreSQL の pub/sub を観測するボトムパネル (`pgListen` タブ、診断グループ)。読み取りのみで
`read_only` でも使える。`NOTIFY` の送信機能は持たない。

- `commands/listen.rs` の `start_pg_listen` が専用接続を 1 本張り (`db/postgres.rs::open_listener`。
  セッションの `connect_options` を使うので SSH / SSM トンネルのローカルポートでも動く)、
  sqlx の `PgListener` で受けた通知を Tauri Channel (`PgListenMessage`) へ流す。
- チャンネルの追加・削除は `pg_listen_add_channel` / `pg_listen_remove_channel` (`AppState` の
  `pg_listeners` に制御チャネルを登録し、タスクが `select!` で受ける)。停止は `cancel_stream`
  (`StreamKind::Listen`)、切断は `AppState::remove` が止める。パネルを閉じるとフロントが cancel する。
- 純ロジックは `db/pg_listen.rs` (チャンネル名検証・payload 切り詰め) と
  `components/pgListen.ts` (受信バッファ 1000 件で古い順に破棄・検証の鏡・縮退理由)。
- MySQL / SQLite は `unsupported_driver` の理由コードで縮退表示する。限界: 接続が切れて張り直す間の
  通知は届かない (`reconnected` で画面に示す)。AWS IAM 認証の接続は、再接続時に張り直す
  トークンの期限 (15 分) 以降は自動再接続できない。

## レプリケーション監視 (#2180)

ボトムパネルの `replication` タブ (診断グループ)。`commands/server.rs` の `get_replication_status` が
役割 (primary / replica / standalone)・接続先ごとの遅延 (`ReplicationLink`)・スロット
(`ReplicationSlot`) を共通の型 (`db/replication.rs`) で返す。カタログの読み取りのみで `read_only` でも動く。

- PostgreSQL: 送信側は `pg_stat_replication`、受信側は `pg_stat_wal_receiver` + `now() - pg_last_xact_replay_timestamp()`、
  スロットは `pg_replication_slots` (`pg_wal_lsn_diff` = 保持している WAL)。`pg_monitor` / `pg_read_all_stats` /
  スーパーユーザが無いと他ユーザの行が NULL になるので、`missing_privilege = "pg_monitor"` を返しスロットだけ返す。
- MySQL: 8.0.22 以上は `SHOW REPLICA STATUS` / `SHOW REPLICAS`、未満と MariaDB は `SHOW SLAVE STATUS` /
  `SHOW SLAVE HOSTS` (`mysql_replica_status_sql`)。`REPLICATION CLIENT` (MariaDB 10.5.9+ は `SLAVE MONITOR`) が無い (1227 など) ときは
  エラーにせず `missing_privilege` に権限名を入れる。マルチソースは行ごとのチャンネルとして上流に並ぶ。スロットの概念は無く空。
- SQLite は未対応エラー。UI はパネルバー・ツールメニューを `aria-disabled` + 理由にし、コマンドパレットには出さない。
- フロント: `components/ReplicationPanel.tsx` (表示中だけポーリング、履歴に残さない)、純ロジックは
  `components/replication.ts` (非アクティブスロットが 1 GiB 以上の WAL を溜めたら先頭で警告、遅延メーターの閾値 30 秒)。
- スロット削除は実装済み: パネルが SQL プレビュー付きの確認を出したあと、App の `handleDropReplicationSlot` が
  共通ゲート `runGuardedDdl` (#2176) を `forceTypedConfirm` 付きで通す (本番は書き込み承認 + スロット名の型入力)。
  実行は通常の `run_query` で、`pg_drop_replication_slot` は拒否リストにあるので read_only はバックエンドが止める
  (UI も無効 + 理由)。使用中のスロットは削除不可 (ボタン無効 + 理由)。スロット名は文字列リテラルなので `'` を `''` に重ねて埋め込む (`buildDropSlotSql`)。

## デッドロック解析 (#2328)

ボトムパネルの `deadlock` タブ (診断グループ、プロセス監視の隣)。デッドロックはサーバがすぐ片方を巻き戻し、
待機グラフ (#2237) に何も残らないので、エラー (MySQL 1213 / PostgreSQL 40P01 / SQLite `SQLITE_BUSY`) のあとに
サーバが残した記録を読む。入口はエラー表示の「デッドロックを解析」(`DeadlockAnalyzeButton`、`classifyLockError` で判別)。
`commands/deadlock.rs` の `analyze_deadlock` (エラー本文と経過秒を渡す。カタログの読み取りのみで `read_only` でも動く) が
`db/deadlock.rs` の純関数で構造化する。

- MySQL: `SHOW ENGINE INNODB STATUS` の `LATEST DETECTED DEADLOCK` 節 (`parse_innodb_deadlock`)。トランザクションごとの
  スレッド ID・ユーザ・ホスト・SQL・保持中 / 待機中のロック・巻き戻された側、待機の相手 (`waits_on`) を返す。`PROCESS` 権限が
  無いときは理由コード `needs_process_privilege`。検出時刻とサーバの `NOW()` から、最新の報告が今回のエラーのものかを
  `relation` (`related` / `older` / `newer`、`classify_report_age`) で返し、別件なら注記する。`innodb_print_all_deadlocks` が OFF なら
  最新 1 件しか残らないことを案内する。累計は `INNODB_METRICS.lock_deadlocks` (MariaDB は `Innodb_deadlocks`) を `ServerMetrics.deadlocks` へ。
- PostgreSQL: 40P01 の DETAIL (`Process A waits for ShareLock on transaction X; blocked by process B.`) を解析して循環を描く
  (`parse_pg_deadlock_detail`)。`error.rs::sqlx_message` が 40P01 のときだけ DETAIL / CONTEXT をエラー文に足す。循環の pid のうち
  生きているものは `pg_stat_activity` から現在のクエリ・アプリ名・ユーザを補う (デッドロック時のクエリとは限らない)。相手の SQL は
  サーバログにしか出ないので `log_lock_waits` / `deadlock_timeout` を添える。英語以外の `lc_messages` では DETAIL を読めず `no_detail`。
  累計は `pg_stat_database.deadlocks` の合計。
- SQLite: 行ロックが無くデッドロックは起きない (メトリクスも対象外)。`SQLITE_BUSY` の切り分けとして `journal_mode`・`busy_timeout`・
  同じファイルを開き明示トランザクションを保持している他の接続 (`holders`、セッション横断はコマンド層) を返す。
- 報告中の SQL とクエリは `sql_credentials::redact_credentials` を通す (資格情報リテラルの伏せ字)。
- フロント: `components/DeadlockPanel.tsx`、純ロジックは `components/deadlock.ts` (循環のたどり方・理由コード → 文言)。

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

**DDL 成功時の自動取得 (#1537)。** DDL (`sql_may_change_schema`) の成功を `App.tsx` の
`noteSchemaDdl` が `schemaDrift.ts::createDdlCaptureCoalescer` に渡し、同じプロファイルの
DDL を**静かになってから 3 秒 (最大 15 秒) まとめて 1 回だけ** `schema_drift_capture` する
(頻繁な DDL / スクリプトの連続実行で取得が走り続けない)。実行先がプロファイルの既定
データベースのときだけ対象 (`isDriftTracked`。別 DB への DDL を混ぜると前世代比較が
無意味になる)。**PostgreSQL ではツリー/タブの「データベース」はスキーマ名で、プロファイルの
`database` は実 DB 名**なので、取得対象は `schema_drift::resolve_capture_database` が
`current_schema()` (空・実 DB 名が渡されたとき。無ければ `public`) に解決し、応答の `database`
(= 世代の `database`) をフロントが記録対象として覚えて、DDL の実行先をスキーマ名同士で比べる。
接続時・手動の取得も同じ解決を通る。以前の世代 (実 DB 名で空を取っていた) との境目は、対象が
違うのでサマリを作らない (`schema_drift_capture` は `summary: null`、`schema_drift_compare` は `null`、
パネルは「対象が異なる世代のため比較しません」を表示)。MySQL / SQLite は従来どおりプロファイルの DB をそのまま使う。エディタ実行のほか、テーブル保守・複製・ALTER・一括削除の GUI 経路も呼ぶ。
`schema_drift_capture` の `trigger_sql` が世代 (`generation.trigger_sql` 列。旧 DB には
`ALTER TABLE ADD COLUMN` で後付け) に紐づき、`GenerationMeta.triggerSql` としてパネルの
世代一覧に出る。`skip_history` の接続では SQL を保存しない。設定 `schemaDriftOnDdl` (既定オン)。
変化のトーストには「タイムラインを開く」アクションが付き、差分リストの各テーブル行から
構造タブ / データタブを開ける (`onOpenStructure` / `onOpenData`)。

実行計画のウォッチ (#743) は別機能で、`components/PlanWatchPanel.tsx` /
`planDiff.ts` / `planWatch.ts` が担います (`noobdb-frontend` スキル参照)。
