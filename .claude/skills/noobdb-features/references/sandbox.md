# サンドボックス (壊せる砂場・ブランチ、#747)

## サンドボックス (壊せる砂場・ブランチ、#747)

選択したテーブル群 (+ 任意で FK の推移的閉包) をローカル SQLite ファイルへコピーし、
独立したセッションとして開く機能です。既存のエディタ/グリッド/セル編集 UI をそのまま
使え、何をしても元の接続には一切影響しません。差分計算・SQL 生成・適用は新規コマンドを
最小限に留め、既存の Diff/Sync 機能 (`generate_sync_sql` / `generate_data_sync_sql` /
`apply_sync_sql`) をそのまま再利用します — サンドボックスの書き戻しは、元 DB から見れば
ただの sync apply です。

- `db/sandbox.rs`: 純粋・ドライバ非依存のロジック。テーブルごとに複製する
  「凍結された base スナップショット」の命名規約 (`shadow_table_name` =
  `__noobdb_sandbox_base__<table>` プレフィックス、`is_shadow_table_name` でテーブル
  ツリーから隠す判定に使う)、行数上限のクランプ (`clamp_row_limit`、既定 5,000 / 上限
  100,000)、FK 推移的閉包 (`fk_closure`。参照先方向のみの片方向 — `schemaExport.ts` の
  双方向閉包とは意図的に異なる)、`Value` → `import_rows` 用セル文字列変換
  (`value_to_cell` / `row_to_cells`)、**競合検出** (`detect_conflicts` — サンドボックス側
  [live vs base] の diff と元 DB 側 [current vs base] の diff を同じ base に対して
  計算し、両方に現れる主キーを競合として突き合わせる)、競合を「スキップ」解決した行を
  除く `filter_out_keys`、スキーマの外部競合テーブル一覧 `schema_conflict_tables` を
  持ちます。
- `sandboxes/store.rs`: サンドボックスの非秘密メタデータ (`SandboxRecord`: 名前・
  ソースプロファイル/ドライバ/DB・テーブル一覧・行数上限・SQLite ファイルパス・作成日時)
  を `sandboxes.json` に永続化する、`profiles::store` / `snippets::store` と同じ
  JSON ファイルストアパターン。SQLite ファイル自体は `<data_dir>/sandboxes/<id>.sqlite`。
- `commands/sandbox.rs`:
  - `create_sandbox`: 選択テーブル (+ FK 閉包) の列メタデータを取得し、
    `compute_schema_diff` + `generate_sync_sql` を **SQLite 方言**で走らせて
    CREATE TABLE 一式を生成・実行 (テーブルごとに実名 + `shadow_table_name` の 2 つを
    作成)、行データは `import_rows` で両方へ投入します。作成した SQLite 接続はそのまま
    通常のセッションとして `AppState` に登録して返します。
  - `list_sandboxes` / `discard_sandbox` (セッションを閉じ、SQLite ファイル + メタデータを
    削除)。
  - `sandbox_table_diff` / `sandbox_schema_diff`: サンドボックスの live テーブルと
    shadow (base) テーブルを比較した「書き戻し案」(`desired`。`target_driver` は元 DB の
    ドライバなので、そのまま `generate_data_sync_sql` / `generate_sync_sql` に渡せる) と、
    任意で渡された元 DB セッションの現在値を同じ base と比較した「外部変更」を
    `detect_conflicts` / `schema_conflict_tables` で突き合わせた競合情報を返します。
  - `filter_sandbox_data_diff`: 競合を「スキップ」解決した行を desired diff から除く
    純粋コマンド (`generate_data_sync_sql` へ渡す前にフロントが呼ぶ)。
  - `sandbox_advance_base`: 書き戻し成功後に呼び、適用済みの行だけ shadow (base) を
    現在値へ進めます。呼ばないと、同じ行が次回の差分計算で「サンドボックス側も元 DB
    側も変化した」という偽の競合として出続けます (`allow_delete` を
    `generate_data_sync_sql` と揃え、実際に削除されなかった `TargetOnly` 行の base は
    残す)。
  - 適用そのものは新規コマンドを作らず、既存の `apply_sync_sql` をそのまま使います
    (read_only セッション拒否・トランザクション適用などの安全網もそのまま効きます)。
  - **`sandbox_session_id` を受け取るコマンドは、そのセッションが本当にその
    サンドボックスのものかを検証してから使います** (`get_sandbox_session`。
    `SandboxRecord` の SQLite ファイルパスとセッションの `connect_options.file_path`
    を突き合わせる。`commands/local.rs::get_local_session` と同じ発想)。検証が無いと
    IPC を直接叩いて任意のセッション — 本番の読み取り専用接続を含む — を対象にでき、
    `sandbox_advance_base` は `execute_transaction` を直接呼ぶ経路なので
    `ensure_allowed_for_session` も通りません。`sandbox_advance_base` には
    `apply_sync_sql` と同じ read_only 拒否も入れてあります。
  - **予約プレフィックスの検査は FK 閉包を展開した後にも適用します。** ユーザ指定の
    `tables` だけを見ていると、`__noobdb_sandbox_base__*` という名前の実テーブルが
    `fk_closure` 経由で紛れ込み、影テーブルと実名が衝突して差分計算が壊れます
    (黙って除外すると閉包が不完全になり後段で気付けないため、エラーで弾きます)。
- フロントは `sandbox.ts` の純ロジック (影テーブル判定・行数上限クランプ・FK 閉包の
  プレビュー・競合解決状態の集計) に加え、**`SandboxRecord` を非永続の合成
  `ConnectionProfile` に変換する `sandboxToProfile`** が肝です。これにより、
  サンドボックスは `save_profile` を一切経由せずに複数同時接続レジストリ
  (`openConnections`)・タブ復元・切替など既存の仕組みへそのまま乗ります (`id` は
  `sandbox:<id>` という予約プレフィックスで通常のプロファイル id と衝突しません)。
  接続先への無影響を常時明示するため、専用色 (violet、`SANDBOX_BAND_COLOR`) と
  `SandboxBadge` (タイトルバー下端の帯・バッジ) で他の接続と視覚的に区別します。
  UI は `ConnectionList` の DB 右クリックメニューから開く `SandboxCreateModal`
  (テーブル選択・FK 自動追加・行数上限・方言近似の限界を明記)、サイドバーの専用
  セクション `SandboxSection` (通常のプロファイルツリー/並べ替えとは独立 — 詳細は
  同コンポーネントのコメント)、変更確認・書き戻しの `SandboxReviewModal` (スキーマ/
  データ差分表示・競合行ごとの上書き/スキップ選択・SQL 生成プレビュー・適用。本番
  接続への適用は `SchemaCompareView` と同じ型入力確認を経由) の 3 つです。
