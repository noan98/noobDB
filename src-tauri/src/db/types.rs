use serde::{Deserialize, Serialize};

/// DB-agnostic value type returned to the frontend as JSON.
///
/// `Serialize` は手書き ([`impl Serialize for Value`])。`Deserialize` は untagged の derive。
///
/// `Deserialize` は `ValueDe` 経由で、JS の安全整数の外にある整数 (フロントの `number` 由来で、
/// もともと f64 だったもの。DOUBLE 列の 1e16 など) を `Float` に寄せる (#1780)。
/// そのまま `Int` / `UInt` にすると、受け取った値を返すコマンドで Serialize 境界の
/// 不変条件に触れる。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(from = "ValueDe")]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    String(String),
    /// Hex-encoded for arbitrary BLOBs to keep JSON safe.
    Bytes(String),
}

/// [`Value`] の `Deserialize` 用の素直な untagged 表現。
#[derive(Deserialize)]
#[serde(untagged)]
enum ValueDe {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    String(String),
    Bytes(String),
}

impl From<ValueDe> for Value {
    fn from(v: ValueDe) -> Self {
        match v {
            ValueDe::Null => Value::Null,
            ValueDe::Bool(b) => Value::Bool(b),
            ValueDe::Int(i) if Value::Int(i).is_js_safe() => Value::Int(i),
            ValueDe::Int(i) => Value::Float(i as f64),
            ValueDe::UInt(u) if Value::UInt(u).is_js_safe() => Value::UInt(u),
            ValueDe::UInt(u) => Value::Float(u as f64),
            ValueDe::Float(f) => Value::Float(f),
            ValueDe::String(s) => Value::String(s),
            ValueDe::Bytes(s) => Value::Bytes(s),
        }
    }
}

/// 浮動小数の文字列表現。有限値は Rust の `to_string()`、非有限値は JS の `String(v)` と
/// 同じ `NaN` / `Infinity` / `-Infinity`。IPC の JSON ([`Value`] の `Serialize`) と
/// CSV / Markdown / xlsx のエクスポートで同じ綴りにそろえる (#1597)。
pub fn float_text(f: f64) -> String {
    if f.is_nan() {
        "NaN".to_string()
    } else if f.is_infinite() {
        if f > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
    } else {
        f.to_string()
    }
}

/// 非有限の `Float` は JSON の数値で表せず、serde_json は黙って `null` にする (フロントで
/// NULL と区別がつかなくなる)。そのため文字列 (`"NaN"` / `"Infinity"` / `"-Infinity"`) で出す。
/// DECIMAL / NUMERIC の `Infinity` を文字列で返す方針 (postgres.rs) と同じ (#1597)。
impl Serialize for Value {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => serializer.serialize_unit(),
            Value::Bool(b) => serializer.serialize_bool(*b),
            Value::Int(i) => {
                debug_assert_serialize_js_safe(self);
                serializer.serialize_i64(*i)
            }
            Value::UInt(u) => {
                debug_assert_serialize_js_safe(self);
                serializer.serialize_u64(*u)
            }
            Value::Float(f) if f.is_finite() => serializer.serialize_f64(*f),
            Value::Float(f) => serializer.serialize_str(&float_text(*f)),
            Value::String(s) | Value::Bytes(s) => serializer.serialize_str(s),
        }
    }
}

/// Serialize 境界の不変条件チェック (#1780)。
fn debug_assert_serialize_js_safe(v: &Value) {
    // IPC 越えの全 Value シリアライズ境界での不変条件チェック。どのモジュールが組み立てた
    // Value でも、安全整数 (2^53 - 1) を超える整数が素の JSON 数値として出る前に debug
    // ビルド (テスト) で検出する。release は無コスト (debug_assert)。出力形式は変えない。
    debug_assert!(
        v.is_js_safe(),
        "安全整数 (2^53 - 1) を超える整数を Value::Int/UInt のまま IPC へ出力しようとしました: {v:?}。\
         Value::from_i64_lossless / from_u64_lossless を経由してください (#1780)"
    );
}

/// JS の `Number.MAX_SAFE_INTEGER` (2^53 - 1)。
///
/// [`Value`] は `#[serde(untagged)]` なので `Int`/`UInt` は JSON の素の数値として
/// シリアライズされ、フロントでは `JSON.parse` により IEEE754 倍精度の `number` に
/// なる。したがってこの範囲を超える整数は **IPC を跨いだ時点で丸められて別の値に
/// なる** — 表示・コピー・エクスポートが静かに誤った値になるだけでなく、
/// インラインセル編集が丸めた値で `WHERE pk = ...` を組み立てるため、丸め後の値が
/// 実在する別の主キーと一致すると**意図しない行を書き換えうる**。
pub const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

impl Value {
    /// 符号付き整数を「JSON を跨いでも精度が落ちない」表現へ変換する。
    ///
    /// 安全整数の範囲内なら数値のまま (`Int`)、超えるなら十進文字列
    /// (`String`) にする。DECIMAL/NUMERIC が桁あふれ時に文字列へ退避するのと
    /// 同じ方針で、フロントの `cellEdit.ts` も「2^53 を超える整数は文字列で
    /// 届く」前提で書かれている。
    pub fn from_i64_lossless(v: i64) -> Self {
        if (-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&v) {
            Value::Int(v)
        } else {
            Value::String(v.to_string())
        }
    }

    /// 単精度浮動小数 (PostgreSQL の `FLOAT4`/`real`、MySQL の `FLOAT`) を `Value::Float` にする (#1534)。
    ///
    /// `f as f64` で広げると、`3.14f32` が `3.140000104904175` のように f32 の丸め誤差ごと
    /// 倍精度の桁数で表示され、DB 上の `3.14` と食い違う (インラインセル編集が元の値を書き戻す
    /// ときも混乱する)。f32 の最短表記 (往復して元の f32 に戻る最短の十進表記) を経由して
    /// f64 に直すと、DB が見せる値と同じ `3.14` になる。NaN / 無限大は文字列化せずそのまま広げる。
    pub fn from_f32_shortest(v: f32) -> Self {
        if !v.is_finite() {
            return Value::Float(f64::from(v));
        }
        Value::Float(
            v.to_string()
                .parse::<f64>()
                .unwrap_or_else(|_| f64::from(v)),
        )
    }

    /// [`Value::from_i64_lossless`] の符号なし版 (MySQL の `BIGINT UNSIGNED` 等)。
    pub fn from_u64_lossless(v: u64) -> Self {
        if v <= JS_MAX_SAFE_INTEGER as u64 {
            Value::UInt(v)
        } else {
            Value::String(v.to_string())
        }
    }

    /// [`Value::from_i64_lossless`] の 128bit 版 (64bit を超える整数値向け)。
    /// `i64` に収まらない値も含めて、安全整数の外は必ず文字列になる。
    pub fn from_i128_lossless(v: i128) -> Self {
        let max = JS_MAX_SAFE_INTEGER as i128;
        if (-max..=max).contains(&v) {
            Value::Int(v as i64)
        } else {
            Value::String(v.to_string())
        }
    }

    /// [`Value::from_i128_lossless`] の符号なし版。
    pub fn from_u128_lossless(v: u128) -> Self {
        if v <= JS_MAX_SAFE_INTEGER as u128 {
            Value::UInt(v as u64)
        } else {
            Value::String(v.to_string())
        }
    }

    /// JSON を跨いでも値が変わらないか (#1422)。
    ///
    /// `Int` / `UInt` は安全整数 (±[`JS_MAX_SAFE_INTEGER`]) の範囲内のときだけ `true`。
    /// それ以外のバリアントは数値の丸めが起きないので常に `true`
    /// (`Float` はもともと f64 で、JS の `number` と同じ精度)。
    pub fn is_js_safe(&self) -> bool {
        match self {
            Value::Int(v) => (-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(v),
            Value::UInt(v) => *v <= JS_MAX_SAFE_INTEGER as u64,
            _ => true,
        }
    }

    /// デコーダの出口で「安全整数の外の `Int` / `UInt` を作っていない」ことを
    /// debug ビルドで検査し、値をそのまま返す (#1422)。
    ///
    /// 3 ドライバの `decode_cell` はすべてこれを通して値を返す。新しいデコーダ分岐が
    /// `Value::Int(n)` を直接組み立てて 2^53 を超える値を素通しすると、テスト
    /// (debug ビルド) の時点でここが落ちる。リリースビルドでは何もしない
    /// (実行時コストを足さず、ユーザの操作も止めない)。
    pub fn debug_assert_js_safe(self) -> Self {
        // debug_assert を使う根拠: この不変条件が破れると、インラインセル編集の
        // `WHERE pk = <丸めた値>` が実在する別の行を書き換えうる (静かな行破壊)。
        // 開発中・CI のテストで確実に止めたい一方、リリースで panic させると
        // 結果表示ごと落ちるため、検査は debug ビルドに限る。
        debug_assert!(
            self.is_js_safe(),
            "安全整数 (2^53 - 1) を超える整数を Value::Int/UInt のまま返しました: {self:?}。\
             デコーダは Value::from_i64_lossless / from_u64_lossless を経由してください (#1422)"
        );
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
    /// Wall-clock duration in milliseconds for client-side display.
    pub elapsed_ms: u64,
    /// サーバが文の実行中に返した通知・警告 (#1165)。PostgreSQL の NOTICE /
    /// WARNING、MySQL の `SHOW WARNINGS`。SQLite と、捕捉できなかった経路は空。
    /// `#[serde(default)]` なので、このフィールドを持たない JSON (キャッシュ等)
    /// も読める。
    #[serde(default)]
    pub server_messages: Vec<ServerMessage>,
}

impl QueryResult {
    pub fn empty(rows_affected: u64, elapsed_ms: u64) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected,
            elapsed_ms,
            server_messages: Vec::new(),
        }
    }

    /// サーバ側メッセージ (#1165) を載せた結果を返す。
    pub fn with_server_messages(mut self, server_messages: Vec<ServerMessage>) -> Self {
        self.server_messages = server_messages;
        self
    }
}

/// サーバ側メッセージの重大度 (#1165)。ドライバ固有の語彙を UI が扱う 4 段に
/// 正規化する: PostgreSQL の NOTICE → `Notice`、WARNING → `Warning`、
/// INFO / LOG / DEBUG → `Info`。MySQL の Note → `Info`、Warning → `Warning`、
/// Error → `Error`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServerMessageSeverity {
    Error,
    Warning,
    Notice,
    Info,
}

/// サーバが文の実行中に返した通知・警告 1 件 (#1165)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerMessage {
    pub severity: ServerMessageSeverity,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,
    pub default: Option<String>,
    pub extra: String,
    /// When this column is a foreign key, the table it references; `None` otherwise.
    pub referenced_table: Option<String>,
    /// The referenced column for the foreign key, when the driver can resolve it.
    pub referenced_column: Option<String>,
    /// 列コメント (#1002)。MySQL `COLUMN_COMMENT` / PostgreSQL `col_description`。
    /// コメントが無い列と SQLite (コメント機能なし) は `None`。`#[serde(default)]`
    /// なので、このフィールドを持たない JSON (スナップショット等) も読める。
    #[serde(default)]
    pub comment: Option<String>,
}

impl TableColumnInfo {
    /// 生成列 (MySQL の `STORED/VIRTUAL GENERATED`、MariaDB の `PERSISTENT GENERATED`、
    /// PostgreSQL の `GENERATED ALWAYS AS (...) STORED`) か。ドライバは `extra` に
    /// `... GENERATED` を入れる規約で、DB が値を計算するため INSERT / UPDATE では
    /// 値を渡せない (渡すとエラー)。SQLite は `PRAGMA table_info` が生成列を返さない
    /// ので、列一覧にそもそも現れない。
    pub fn is_generated(&self) -> bool {
        let up = self.extra.to_ascii_uppercase();
        [
            "STORED GENERATED",
            "VIRTUAL GENERATED",
            "PERSISTENT GENERATED",
        ]
        .iter()
        .any(|m| up.contains(m))
    }
}

/// 生成列の列名一覧 (データ同期・サンドボックス書き戻しの書き込み対象から外す用)。
pub fn generated_column_names(cols: &[TableColumnInfo]) -> Vec<String> {
    cols.iter()
        .filter(|c| c.is_generated())
        .map(|c| c.name.clone())
        .collect()
}

/// テーブル (またはビュー) のコメント 1 件 (#1002)。`list_table_comments` は
/// コメントを持つものだけを返す (空コメントは含めない)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableComment {
    pub name: String,
    pub comment: String,
}

/// 1 テーブル分のインデックス一覧。`indexes_for_database` の戻り値の要素
/// (#1255)。インデックスを 1 つも持たないテーブルは結果に現れない。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableIndexes {
    pub name: String,
    pub indexes: Vec<IndexInfo>,
}

/// 空文字 / 空白だけのコメントを `None` に正規化する (#1002)。MySQL は
/// コメント無しを空文字で返すため、ドライバ間で「無い」の表現をそろえる。
pub fn non_empty_comment(s: Option<String>) -> Option<String> {
    s.filter(|c| !c.trim().is_empty())
}

/// One foreign-key relationship within a database, used to draw the ER
/// diagram's edges. There is one entry per referencing column; the columns of
/// a composite foreign key share the same `constraint_name`. `referenced_column`
/// is `None` only when the driver cannot resolve the target column (e.g. an
/// implicit SQLite foreign key onto a composite primary key) — the referencing
/// table/column and the referenced table are always present.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForeignKey {
    pub table: String,
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: Option<String>,
    /// Constraint name when the engine exposes one. Lets the UI group the
    /// columns of a composite key into a single edge. `None` when unavailable.
    pub constraint_name: Option<String>,
    /// `ON DELETE` の参照動作 (`CASCADE` / `SET NULL` / `SET DEFAULT` / `RESTRICT`)。既定の
    /// `NO ACTION` と、取得していないドライバは `None`。DDL 再構成と `CREATE TABLE` 同期
    /// (MySQL / PostgreSQL / SQLite 共通) だけが使う内部用で、IPC には出さない。
    #[serde(skip)]
    pub on_delete: Option<String>,
    /// `ON UPDATE` の参照動作。意味は `on_delete` と同じ。
    #[serde(skip)]
    pub on_update: Option<String>,
}

/// 参照動作 (`ON DELETE` / `ON UPDATE`) の表記を揃える。既定の `NO ACTION` と
/// 空・未取得は `None` (DDL に出さない)。MySQL の `information_schema` と SQLite の
/// `PRAGMA foreign_key_list` が使う。
pub fn normalize_fk_action(action: Option<&str>) -> Option<String> {
    let a = action?.trim().to_ascii_uppercase();
    match a.as_str() {
        "" | "NO ACTION" => None,
        _ => Some(a),
    }
}

/// One index on a table. Carries the index name, its constituent columns
/// in order, and whether it is UNIQUE / the PRIMARY KEY. `method` is the access
/// method when the engine exposes one (e.g. PostgreSQL `btree`/`gin`, MySQL
/// `BTREE`/`HASH`); `None` for SQLite, which has no such concept.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub method: Option<String>,
    /// 部分インデックスの述語 (PostgreSQL の `pg_index.indpred` / SQLite の `WHERE` 句)。
    /// IPC には出さない内部用 (アドバイザの重複判定と DDL 再構成が使う)。
    #[serde(skip)]
    pub predicate: Option<String>,
    /// 最初の式キー（名前を持たないキー列）の位置 = それより前にある実列の数。式を含まなければ
    /// `None`。`columns` には式の列が積まれないため、列だけで同一視・再構成すると別物のインデックスに
    /// なる。先頭からこの位置までの実列は FK 被覆の判定に使える。IPC には出さない内部用。
    #[serde(skip)]
    pub first_expression_at: Option<usize>,
    /// PostgreSQL: キー列の数 (`pg_index.indnkeyatts`)。`columns` はキー列の後ろに
    /// `INCLUDE` 列が続くので、DDL 再構成でこの位置で区切る。`None` は全列がキー列。
    /// IPC には出さない内部用。
    #[serde(skip)]
    pub key_column_count: Option<usize>,
    /// PostgreSQL: `columns` と同じ並びの列ごとの並び順指定 (`" DESC"` / `" NULLS FIRST"` など。
    /// 既定の ASC NULLS LAST は空文字)。空配列は全列が既定。IPC には出さない内部用。
    #[serde(skip)]
    pub column_options: Vec<String>,
    /// PostgreSQL 15+ の `NULLS NOT DISTINCT` な UNIQUE インデックスか。IPC には出さない内部用。
    #[serde(skip)]
    pub nulls_not_distinct: bool,
}

/// ストアドプロシージャ / 関数の 1 パラメータ (#1003)。`get_routine_signature`
/// が返し、フロントの `routineCall.ts` が呼び出し SQL (CALL / SELECT / EXEC) を
/// 組み立てる材料にする。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutineParameter {
    /// パラメータ名。PostgreSQL の無名引数は空文字。
    pub name: String,
    /// 入出力モード: `in` / `out` / `inout` / `variadic` / `table`
    /// (`table` は PostgreSQL の `RETURNS TABLE(...)` の出力列)。
    pub mode: String,
    /// 型名 (表示用かつ PostgreSQL ではキャスト先 — `format_type` の出力)。
    pub data_type: String,
}

/// ルーチンのシグネチャ (#1003)。`kind` は `procedure` / `function`。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutineSignature {
    pub kind: String,
    pub name: String,
    /// 宣言順のパラメータ (戻り値そのものは含まない)。
    pub parameters: Vec<RoutineParameter>,
    /// 関数が集合 (行の集合 / テーブル値) を返すか。true なら
    /// `SELECT * FROM fn(...)` の形で呼ぶ。プロシージャは常に false。
    pub returns_set: bool,
    /// 関数の戻り値型 (表示用)。プロシージャや取得できない場合は `None`。
    pub return_type: Option<String>,
}

/// A non-table schema object: a view, materialized view, stored
/// procedure, function, or trigger. `kind` is one of `view` /
/// `materialized_view` / `procedure` / `function` / `trigger` so the UI can
/// group them; `name` is the object's identifier within the database/schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaObject {
    pub kind: String,
    pub name: String,
    /// 同名衝突を避けるための一意識別子。PostgreSQL では関数/手続き/トリガーの
    /// `oid` を文字列で持ち、`object_definition` に渡して正しい 1 件を引く (オーバーロード
    /// 関数やテーブル別同名トリガーの取り違えを防ぐ)。名前で一意な種別 (ビュー等) や
    /// MySQL/SQLite では `None`。
    #[serde(default)]
    pub id: Option<String>,
}

/// One table (or view) and its column names, used to feed whole-schema SQL
/// autocomplete. Only names are carried — type/key metadata lives in the
/// per-table `TableColumnInfo` path, which the editor does not need for
/// completion.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSchema {
    pub name: String,
    pub columns: Vec<String>,
}

/// Approximate row count for one base table, read from the engine's own
/// statistics catalogs (no `COUNT(*)` scan), so it stays cheap on large
/// schemas and never touches table data.
///
/// `estimate` is intentionally fuzzy:
/// - `Some(n)` is the engine's reported estimate. It may be stale (it updates
///   only when the engine gathers statistics) and, for some engines (InnoDB),
///   is approximate even when fresh.
/// - `None` means no cheap estimate is available — the driver has no such
///   statistic (SQLite), or the engine has not gathered one yet.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRowEstimate {
    pub name: String,
    /// i64 精度方針 (#625): この値は JSON 数値としてフロントへ渡り、JS の `number`
    /// (安全整数 ±(2^53-1)) で受ける。2^53 を超える推定行数では精度が静かに落ちうるが、
    /// **概算表示 (`~1.2K`) 専用**であり超過は現実に起きない/起きても丸めに留まるため
    /// **許容する** (文字列化しない)。`TableSizeInfo` のバイト数や `ProcessInfo.id` /
    /// `time_secs` も同じ方針 (現実的なレンジが安全整数に収まる)。詳細は
    /// `src/api/schemas.ts` の `tableRowEstimate` コメントと `serde_schema_parity.rs`。
    pub estimate: Option<i64>,
}

/// Size and row statistics for one base table, used by the size/statistics
/// dashboard (#562). All byte counts come from the engine's own catalogs (no
/// table scan): MySQL `information_schema.TABLES` (`DATA_LENGTH` /
/// `INDEX_LENGTH`), PostgreSQL `pg_table_size` / `pg_indexes_size` /
/// `pg_total_relation_size`, SQLite `dbstat` aggregated per table (when the
/// build exposes it).
///
/// Every byte/row field is `Option` because an engine may not report it: SQLite
/// keeps no cheap row estimate (`row_estimate` stays `None`, mirroring
/// [`TableRowEstimate`]), and `dbstat` is absent on SQLite builds without
/// `SQLITE_ENABLE_DBSTAT_VTAB` (all size fields stay `None`). `total_bytes` is
/// the engine's reported total when available, otherwise the sum of the data
/// and index parts the driver could resolve.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableSizeInfo {
    pub name: String,
    pub row_estimate: Option<i64>,
    pub data_bytes: Option<i64>,
    pub index_bytes: Option<i64>,
    pub total_bytes: Option<i64>,
    /// 不要行 (dead tuple) の概算数 (#1622)。PostgreSQL の `pg_stat_user_tables.n_dead_tup`。
    /// 取れない / 他ドライバは `None`。
    #[serde(default)]
    pub dead_rows: Option<i64>,
    /// 最後に VACUUM された時刻 (手動・autovacuum の新しい方, Unix 秒)。PostgreSQL のみ。
    #[serde(default)]
    pub last_vacuum_at: Option<i64>,
    /// 最後に ANALYZE された時刻 (手動・autoanalyze の新しい方, Unix 秒)。PostgreSQL のみ。
    #[serde(default)]
    pub last_analyze_at: Option<i64>,
}

/// One name/value pair from a server's configuration or status catalogs, shown
/// in the server-info panel (#563). MySQL maps `SHOW VARIABLES`, PostgreSQL
/// `pg_settings` (name/setting), SQLite a curated set of `PRAGMA` results. The
/// value is always rendered as text — the panel is read-only and never edits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerVariable {
    pub name: String,
    pub value: String,
    /// 値の出どころ (#1622)。PostgreSQL は `pg_settings.source` (`default` / `configuration file` /
    /// `session` など)、MySQL 8 は `performance_schema.variables_info` を小文字化したもの
    /// (`COMPILED` は `default`)。取れない / SQLite は `None`。`default` 以外が「既定値から変更済み」。
    #[serde(default)]
    pub source: Option<String>,
}

/// Read-only snapshot of the connected server for the server-info panel (#563):
/// its version string and a searchable list of configuration variables. Active
/// connections are not duplicated here — the process monitor
/// ([`ProcessInfo`]) already covers them. Gathered purely with read-only
/// queries; no secret or connection-string material is included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub version: String,
    pub variables: Vec<ServerVariable>,
}

/// サーバランタイムの軽量メトリクス 1 サンプル (#731)。監視ダッシュボードが一定間隔で
/// ポーリングし、フロントの在メモリ・リングバッファに蓄積して接続数 / QPS / ロック待ちを
/// 時系列グラフ化する。**1 回のサンプリングで軽い読み取りのみ** — MySQL は
/// `SHOW GLOBAL STATUS`、PostgreSQL は `pg_stat_activity` / `pg_stat_database` の集計で、
/// テーブル I/O は発生しない。サーバ状態を変更しないためポーリングしても安全で、
/// `list_processes` と同じく read_only セッションでも許可する。
///
/// **ゲージ (瞬時値) とカウンタ (累積値) が混在する**。QPS/TPS のような**レートは
/// 累積カウンタの 2 サンプル差分**からフロントの純ロジック (`serverMetrics.ts`) が
/// 算出する — サーバ側の統計リセット権限が無くても使えるようにするため (#746 の
/// digest 差分と同じ発想)。フロントは各サンプルを受信時刻でスタンプするため、
/// バックエンドはタイムスタンプを含めない (クロック依存を避ける)。
///
/// フィールドはドライバ非依存の共通表現で、エンジンが報告しない項目は `None`。
/// スループットの意味はドライバで異なる (MySQL `Questions` = ステートメント数、
/// PostgreSQL = トランザクション数 `xact_commit + xact_rollback`) ため、フロントは
/// ドライバ種別でラベル (QPS / TPS) を切り替える。権限不足で一部の集計が読めない
/// 場合は該当フィールドのみ `None` に縮退させ、全体は失敗させない (取得できた範囲で
/// degrade)。SQLite はサーバを持たずエラーを返す (`list_processes` と同じ短絡方針)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerMetrics {
    /// クライアント接続数 (ゲージ)。MySQL `Threads_connected`、PostgreSQL の
    /// client backend 数。
    pub connections: Option<i64>,
    /// 実行中 (非スリープ/アクティブ) の接続・スレッド数 (ゲージ)。MySQL
    /// `Threads_running`、PostgreSQL `state = 'active'` の数。
    pub active: Option<i64>,
    /// トランザクション開始済みだがアイドルな接続数 (ゲージ)。PostgreSQL
    /// `state LIKE 'idle in transaction%'`。MySQL は同等の状態が無く `None`。
    pub idle_in_transaction: Option<i64>,
    /// いまロック取得を待っている接続・スレッド数 (ゲージ)。MySQL
    /// `Innodb_row_lock_current_waits`、PostgreSQL `wait_event_type = 'Lock'` の数。
    pub lock_waiting: Option<i64>,
    /// スループットカウンタ (累積)。MySQL `Questions` (実行ステートメント数)、
    /// PostgreSQL `sum(xact_commit + xact_rollback)` (トランザクション数)。フロントが
    /// 2 サンプルの差分を経過秒で割り QPS/TPS を出す。
    pub questions: Option<i64>,
    /// スロークエリ数 (累積)。MySQL `Slow_queries`。PostgreSQL は同等の常設カウンタが
    /// 無く `None`。
    pub slow_queries: Option<i64>,
    /// 行ロック待ちが発生した累積回数。MySQL `Innodb_row_lock_waits`。PostgreSQL は
    /// 同等の安価な累積カウンタが無く `None` (待ち数は `lock_waiting` ゲージで見る)。
    pub lock_waits: Option<i64>,
    /// サーバの接続数上限 (ゲージ, #1622)。MySQL `max_connections`、PostgreSQL
    /// `current_setting('max_connections')`。取れなければ `None`。接続数との比で使用率を出す。
    #[serde(default)]
    pub max_connections: Option<i64>,
}

/// One server-side process/connection shown in the process monitor panel.
/// MySQL maps rows from `processlist` (ID/USER/HOST/DB/COMMAND/STATE/TIME/
/// INFO), PostgreSQL from `pg_stat_activity` (pid/usename/client addr/datname/
/// state/wait_event/query age/query). SQLite is file-backed and has no server
/// processes — its driver returns an error instead of an empty list so the
/// frontend can tell "unsupported" from "nothing running".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    /// MySQL connection id / PostgreSQL backend pid. The value passed back to
    /// `kill_processes`.
    pub id: i64,
    pub user: Option<String>,
    /// Client endpoint: MySQL `HOST` (`addr:port`), PostgreSQL
    /// `client_addr:client_port` (`None` for local/unix-socket backends).
    pub host: Option<String>,
    pub database: Option<String>,
    /// Coarse activity: MySQL `COMMAND` (Query/Sleep/...), PostgreSQL `state`
    /// (active/idle/...).
    pub command: Option<String>,
    /// Finer detail: MySQL `STATE`, PostgreSQL `wait_event`.
    pub state: Option<String>,
    /// MySQL: seconds in the current command. PostgreSQL: seconds since the
    /// current/last query started. `None` when the engine reports none.
    pub time_secs: Option<i64>,
    /// The running (or last) SQL text, as the engine reports it.
    pub query: Option<String>,
    /// True when this row is the very connection that ran the listing query —
    /// i.e. one of this app's own pooled connections. Killing it drops the
    /// app's session, so the UI warns before doing that. Best-effort: the
    /// app's *other* pooled connections (same pool, different id) are not
    /// flagged because the engine cannot tell them apart from other clients.
    pub is_self: bool,
    /// このプロセスの進行を (ロック待ちで) 止めているプロセスの id (#1417)。
    /// PostgreSQL は `pg_blocking_pids()`、MySQL 8 は `performance_schema.data_lock_waits`。
    /// 取得できない (権限不足・古い版) / 待っていないときは空。
    pub blocked_by: Vec<i64>,
    /// 長時間メンテナンス (VACUUM / CREATE INDEX) の進捗 (#1622)。PostgreSQL の
    /// `pg_stat_progress_*` から取れたときだけ入る。MySQL / 取得不能は `None`。
    #[serde(default)]
    pub progress: Option<ProcessProgress>,
}

/// プロセスのメンテナンス作業の進捗 (#1622)。`done` / `total` はブロック数 (または行数)。
/// `total` が 0 のフェーズ (索引作成の待機・ソートなど) は割合が出せないので、フェーズ名だけを示す。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessProgress {
    /// `"vacuum"` / `"create_index"`。
    pub kind: String,
    /// サーバが報告するフェーズ名 (例: `scanning heap`)。
    pub phase: String,
    pub done: i64,
    pub total: i64,
}

/// プロセス一覧の 1 行に載せるクエリ要約の最大文字数 (#1259)。
pub const PROCESS_QUERY_SUMMARY_MAX: usize = 200;

/// `list_processes` IPC が返す 1 行。[`ProcessInfo`] との違いはクエリ本文で、全文
/// (巨大な INSERT など) を毎ポーリング・全接続ぶん JS へ送ってから JS で 200 文字に
/// 切り詰めていた (#1259) のを、Rust 側で要約して `query_summary` / `query_truncated`
/// だけ送る。全文はツールチップ表示時などに `get_process_query` で id 指定で取得する。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessListItem {
    pub id: i64,
    pub user: Option<String>,
    pub host: Option<String>,
    pub database: Option<String>,
    pub command: Option<String>,
    pub state: Option<String>,
    pub time_secs: Option<i64>,
    /// 改行・連続空白を 1 スペースに畳み、[`PROCESS_QUERY_SUMMARY_MAX`] 文字で切り詰めて
    /// `…` を付けた 1 行要約。クエリが無い / 空白だけなら `None`。
    pub query_summary: Option<String>,
    /// 要約が全文より短い (切り詰めた) とき true。
    pub query_truncated: bool,
    pub is_self: bool,
    /// ブロッカー (待たされている相手) の id 一覧 (#1417)。待機チェーンのツリー化はフロントで行う。
    pub blocked_by: Vec<i64>,
    /// VACUUM / CREATE INDEX の進捗 (#1622)。
    pub progress: Option<ProcessProgress>,
}

/// クエリ本文を 1 行要約にする。空白の畳み込みは `split_whitespace` (Unicode 空白)、
/// 長さは文字数で数える。空 / 空白だけなら `(None, false)`。
pub fn summarize_process_query(query: Option<&str>, max: usize) -> (Option<String>, bool) {
    let one_line = query
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if one_line.is_empty() {
        return (None, false);
    }
    if one_line.chars().count() <= max {
        return (Some(one_line), false);
    }
    let mut cut: String = one_line.chars().take(max).collect();
    cut.push('…');
    (Some(cut), true)
}

impl From<ProcessInfo> for ProcessListItem {
    fn from(p: ProcessInfo) -> Self {
        let (query_summary, query_truncated) =
            summarize_process_query(p.query.as_deref(), PROCESS_QUERY_SUMMARY_MAX);
        ProcessListItem {
            id: p.id,
            user: p.user,
            host: p.host,
            database: p.database,
            command: p.command,
            state: p.state,
            time_secs: p.time_secs,
            query_summary,
            query_truncated,
            is_self: p.is_self,
            blocked_by: p.blocked_by,
            progress: p.progress,
        }
    }
}

/// 1 プロセスぶんの停止結果の種別 (#1622)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KillOutcomeStatus {
    /// 停止 (または文のキャンセル) を受け付けた。
    Killed,
    /// 対象が既に居なかった (自然終了との競合)。目的は達しているので成功として数える。
    AlreadyGone,
    /// 失敗 (権限不足・不正な id など)。理由は `error`。
    Failed,
    /// 実行しなかった (文のみ停止で自分自身の接続を対象から外した場合)。成功にも失敗にも数えない。
    Skipped,
}

/// プロセス id ごとの停止結果 (#1622)。画面は一覧の行ごとに成否と理由を示せる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KillProcessOutcome {
    pub id: i64,
    pub status: KillOutcomeStatus,
    /// `status == Failed` のときのエラー文。
    pub error: Option<String>,
}

/// `kill_processes` の結果 (#1259 / #1622)。失敗があっても残りは実行を続ける。
/// `killed` / `failed` / `first_error` は従来どおりの集計 (トーストの件数用)、`outcomes` が
/// 入力 id ごとの成否 (自接続を含むときも id 単位なので件数がずれない)。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KillProcessesResult {
    pub killed: u64,
    pub failed: u64,
    pub first_error: Option<String>,
    #[serde(default)]
    pub outcomes: Vec<KillProcessOutcome>,
}

impl KillProcessesResult {
    fn push(&mut self, id: i64, status: KillOutcomeStatus, error: Option<String>) {
        self.outcomes.push(KillProcessOutcome { id, status, error });
    }

    /// 停止を受け付けた id を記録する。
    pub fn record_killed(&mut self, id: i64) {
        self.killed += 1;
        self.push(id, KillOutcomeStatus::Killed, None);
    }

    /// 既に居なかった id を記録する (成功として数える)。
    pub fn record_already_gone(&mut self, id: i64) {
        self.killed += 1;
        self.push(id, KillOutcomeStatus::AlreadyGone, None);
    }

    /// 実行しなかった id を記録する (成功にも失敗にも数えない)。
    pub fn record_skipped(&mut self, id: i64) {
        self.push(id, KillOutcomeStatus::Skipped, None);
    }

    /// 1 つの id の失敗を記録する。
    pub fn record_failure(&mut self, id: i64, error: String) {
        self.failed += 1;
        if self.first_error.is_none() {
            self.first_error = Some(error.clone());
        }
        self.push(id, KillOutcomeStatus::Failed, Some(error));
    }

    /// 複数 id が同じ理由で失敗したときにまとめて記録する。
    pub fn record_failures(&mut self, ids: &[i64], error: &str) {
        for id in ids {
            self.record_failure(*id, error.to_string());
        }
    }
}

/// Row identity strategy for inline editing when a table has no usable
/// primary key (#849): what the frontend should use, instead of PK columns,
/// to build a WHERE clause that targets exactly one physical row.
///
/// `strategy` is one of:
/// - `"primary_key"` — a real PK exists (`TableColumnInfo.key == "PRI"`).
///   Callers normally don't even need to ask for this — `describe_table`
///   already reports it — but it's included so the type is self-describing
///   when a caller checks this first.
/// - `"rowid"` — SQLite table with an implicit rowid (not `WITHOUT ROWID`,
///   not a view, not a virtual table). `hidden_column` is `"rowid"`; the
///   frontend appends it to the browse `SELECT` as a pseudo-column so it
///   comes back with the result set.
/// - `"ctid"` — PostgreSQL ordinary heap table (`pg_class.relkind = 'r'`).
///   `hidden_column` is `"ctid"`. **Caveat**: `ctid` identifies a row's
///   *physical* location and is invalidated by `VACUUM FULL` / `UPDATE`
///   (Postgres itself writes a new tuple with a new ctid on UPDATE) — safe
///   within one grid session's Preview/Apply round trip, not as a durable
///   key across sessions.
/// - `"all_columns"` — no PK and no cheap physical row id (MySQL, SQLite
///   `WITHOUT ROWID` tables, views). The frontend falls back to matching
///   every column in the WHERE clause. This cannot guarantee uniqueness
///   (two rows may be genuinely identical without a PK/UNIQUE constraint),
///   so the frontend must warn before applying an edit built this way.
///   `hidden_column` is `None`.
/// - `"none"` — nothing usable (e.g. the object has no columns, or isn't a
///   plain table). Editing stays disabled, same as before this feature.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableRowIdentity {
    pub strategy: String,
    pub hidden_column: Option<String>,
}

/// One database user / role for the users & privileges panel (#732). MySQL
/// identifies a principal by a `(user, host)` pair (the same user name can
/// have several host-scoped accounts with different privileges), so `host`
/// is `Some`; PostgreSQL roles have no host component and always report
/// `None`. SQLite has no user/permission model — the frontend hides the
/// panel entirely, and the driver returns an error instead of an empty list
/// (matching [`ProcessInfo`]'s "unsupported" convention for direct IPC
/// callers).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbUserInfo {
    pub name: String,
    /// MySQL account host pattern (e.g. `%`, `localhost`). `None` for PostgreSQL.
    pub host: Option<String>,
    /// Human-readable role attributes. MySQL exposes just `SUPER` (the only
    /// global attribute this panel reads out of `mysql.user`); PostgreSQL
    /// exposes the relevant `pg_roles` attribute set (`SUPERUSER` /
    /// `CREATEDB` / `CREATEROLE` / `LOGIN` / `REPLICATION` / `BYPASSRLS`).
    pub attributes: Vec<String>,
    /// PostgreSQL role membership (`pg_auth_members`) — roles this role is a
    /// member of. Always empty for MySQL, which has no role graph.
    pub member_of: Vec<String>,
    pub is_superuser: bool,
    pub can_login: bool,
}

/// One table's (or the whole-database default's) CRUD + DDL privilege flags
/// for a single user/role — one row of the privilege matrix. `table` is `"*"`
/// for the database-wide default row (MySQL `mysql.user` global grants) and
/// `"<db>.<table>"` for a per-table grant (PostgreSQL's `<db>` here is really
/// the schema, matching how [`super::Connection::tables`] already overloads
/// "database" to mean "schema" for PostgreSQL throughout this codebase).
///
/// `ddl` bundles the schema-altering grants each driver actually exposes at
/// this granularity: MySQL `CREATE`/`ALTER`/`DROP`/`INDEX`/`REFERENCES`;
/// PostgreSQL `TRUNCATE`/`REFERENCES`/`TRIGGER` (PostgreSQL grants
/// `CREATE`/`ALTER`/`DROP TABLE` through schema ownership, not per-table
/// `GRANT`, so those are out of scope for this per-table matrix — see
/// `db::privileges` module docs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TablePrivilegeRow {
    pub table: String,
    pub select: bool,
    pub insert: bool,
    pub update: bool,
    pub delete: bool,
    pub ddl: bool,
}

/// The full privilege matrix for one user/role: an optional database-wide
/// default row (`global`, MySQL only — PostgreSQL has no equivalent concept)
/// plus one row per table with an explicit grant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPrivileges {
    pub global: Option<TablePrivilegeRow>,
    pub tables: Vec<TablePrivilegeRow>,
}

/// ライブクエリ・インスペクタ (#746) の前提可否プローブ。ライブテールと
/// digest 集計それぞれについて「使えるか」と、使えないときの**機械可読な理由
/// コード**を返す。黙って空にせず理由を表示して縮退するため (#587 の教訓)、
/// フロントはコードを i18n のヘルプ文言 (有効化手順つき) にマップする。
///
/// 理由コードの一覧 (フロント `queryInspector.ts` と対で維持する):
/// - `unsupported_driver` — SQLite などサーバ統計を持たないドライバ
/// - `performance_schema_off` — MySQL で `performance_schema = OFF`
/// - `statements_consumer_off` — MySQL で events_statements 系 consumer が無効
/// - `statements_digest_off` — MySQL で `statements_digest` consumer が無効
/// - `pg_stat_statements_missing` — PostgreSQL で拡張が未導入
/// - `pg_stat_statements_not_preloaded` — 拡張は導入済みだが
///   `shared_preload_libraries` に無く読めない (postgresql.conf への追記と再起動が要る)
/// - `stats_unreadable` — ソースは存在するが読めない (権限不足・非対応バージョン)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryStatsSupport {
    pub live_tail: bool,
    pub statements: bool,
    pub live_tail_reason: Option<String>,
    pub statements_reason: Option<String>,
}

/// ライブテールの 1 イベント: サーバが観測した実行中/直近のステートメント。
/// MySQL は `performance_schema.events_statements_current` + `_history`、
/// PostgreSQL は `pg_stat_activity` から取る。**取得はすべて読み取り SELECT の
/// ポーリング**で、サーバ設定は変更しない。自セッション由来 (サンプリング接続・
/// noobDB 内部のカタログ参照) はドライバ側で除外するが、同一プールの別物理接続は
/// エンジンから区別できないためベストエフォート ([`ProcessInfo::is_self`] と同じ限界)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveQuery {
    /// ポーリング横断の重複排除キー。MySQL は `THREAD_ID:EVENT_ID`、
    /// PostgreSQL は `pid:query_start エポック`。
    pub key: String,
    pub query: String,
    pub user: Option<String>,
    pub host: Option<String>,
    pub database: Option<String>,
    /// PostgreSQL の `application_name`。MySQL は同等の常設列が無いため `None`。
    pub application: Option<String>,
    /// 実行済みイベントは所要時間、実行中はサンプル時点までの経過 (ms)。
    pub duration_ms: Option<f64>,
    /// MySQL `ROWS_EXAMINED`。PostgreSQL の activity ビューには無く `None`。
    pub rows_examined: Option<i64>,
    /// サンプル時点でまだ実行中なら true。
    pub running: bool,
    /// クエリ開始時刻 (エポック ms)。PostgreSQL の `query_start`。MySQL の
    /// TIMER_START はサーバ起動基準の相対値のため `None` (フロントは観測時刻で代替)。
    pub started_at_ms: Option<f64>,
    /// `normalize_sql_fingerprint` による同型クエリキー (N+1 判定と行グルーピング用)。
    /// ドライバは空で返し、`sample_live_queries` のコマンド層が埋める (#1259)。
    #[serde(default)]
    pub fingerprint: String,
}

/// digest (フィンガープリント) 単位の**累積**統計スナップショット 1 行。
/// MySQL は `events_statements_summary_by_digest` (正規化はサーバ側で完了)、
/// PostgreSQL は `pg_stat_statements` (queryid 単位)。カウンタはサーバの統計
/// リセット以降の累積値であり、「記録開始からの差分」はフロントの純ロジック
/// (`queryInspector.ts` の差分計算) が 2 スナップショットの引き算で求める —
/// リセット権限が無くても使えるようにするため (#746)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatementStat {
    /// 安定キー: MySQL `DIGEST` / PostgreSQL `queryid` の文字列表現。
    pub digest: String,
    /// 正規化済みステートメント本文 (`DIGEST_TEXT` / `pg_stat_statements.query`)。
    pub fingerprint: String,
    pub database: Option<String>,
    /// 実行回数 (累積)。
    pub calls: i64,
    /// 総実行時間 ms (累積)。
    pub total_time_ms: f64,
    /// 最悪レイテンシ ms。**高水位マーク**であり差分計算できない点に注意
    /// (フロントは「累積の最悪値」として表示する)。
    pub max_time_ms: f64,
    /// 走査/処理行数 (累積)。MySQL は `SUM_ROWS_EXAMINED`、PostgreSQL は
    /// `rows` (返却/影響行)。意味がドライバで異なるため UI 側でラベルを変える。
    pub rows: Option<i64>,
}

/// One unit produced by streaming SELECT execution. Columns are reported
/// once (before any rows) so the UI can render headers immediately, then
/// row batches arrive as they are read off the wire.
#[derive(Debug, Clone)]
pub enum StreamBatch {
    Columns(Vec<Column>),
    Rows(Vec<Vec<Value>>),
}

/// Provenance metadata for one table registered into the **local
/// cross-connection query engine** (#740): a result set from any connection,
/// copied in and given a name so it can be re-queried — or JOINed against
/// tables copied from *other* connections — without touching the source
/// database. Persisted by the driver alongside the local engine's own data
/// (currently a per-session SQLite temp file, see `db::sqlite::SqliteConn::
/// register_local_table`) in a hidden catalog table, so the sidebar list
/// survives for the lifetime of the local session without separate
/// `AppState` bookkeeping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalTableMeta {
    pub name: String,
    /// Display name of the source connection (profile name, or a fallback
    /// label for an unsaved/ad-hoc connection). `None` when the source has
    /// since been forgotten.
    pub source_profile: Option<String>,
    /// Profile id of the source connection (#1541). Display names are not
    /// unique, so a refetch matches on this when present; `None` for rows
    /// registered before it was recorded (those fall back to the name).
    #[serde(default)]
    pub source_profile_id: Option<String>,
    /// The SQL that produced the registered rows, kept verbatim so the
    /// sidebar can show provenance.
    pub source_sql: String,
    /// Driver of the *source* connection (`mysql` / `postgres` / `sqlite`),
    /// not the local engine itself.
    pub source_driver: Option<String>,
    /// Database (MySQL) / schema context the source SQL ran against (#1541), so a
    /// refetch runs in the same place. `None` for rows registered before this
    /// was recorded, and for drivers where it does not apply (SQLite).
    #[serde(default)]
    pub source_database: Option<String>,
    /// Registration time, epoch milliseconds (matches the JS `Date.now()`
    /// convention already used by the frontend's own timestamps).
    pub fetched_at_ms: i64,
    /// Row count captured at registration time.
    pub row_count: i64,
}

/// Result of a "dry-run" preview: the SQL is executed inside a transaction
/// that is rolled back afterwards, so the live database is unchanged.
/// `before_rows` and `after_rows` are snapshots of the auto-detected target
/// table (LIMIT 100). When the target table can't be parsed from the SQL,
/// they are empty and `target_table` is `None`.
///
/// `primary_key` carries the target table's primary-key column names (in
/// index order). The frontend uses them to pair before/after rows by PK so
/// the UPDATE diff is meaningful even if the underlying scan order differs
/// or the statement was DELETE/INSERT.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewResult {
    pub target_table: Option<String>,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
    pub before_rows: Vec<Vec<Value>>,
    pub after_rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
    pub elapsed_ms: u64,
    /// True if either snapshot was truncated by the LIMIT.
    pub truncated: bool,
    /// 書き込みキャプチャ (#1536) 専用: 新規行 (INSERT) を窓の差分ではなく DB 側の手がかり
    /// (PostgreSQL の xmin / MySQL の AUTO_INCREMENT) で特定できたとき `true`。
    #[serde(skip)]
    pub new_rows_exact: bool,
    /// 書き込みキャプチャ (#1536) 専用: ドライバ側で記録を辞退すると決めた理由
    /// (行ロックの競合など)。書き込み自体は 1 回実行・COMMIT される。
    #[serde(skip)]
    pub capture_decline: Option<String>,
}

/// 1 データベース (PostgreSQL ではスキーマ) とそのテーブル名一覧。
/// `Connection::tables_all` の戻り値の要素 (#1263)。`tables` は
/// `Connection::tables` と同じ内容・順序 (ビューを含む)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseTables {
    pub database: String,
    pub tables: Vec<String>,
}

/// `(DB 名, テーブル名)` の平らな行を、`databases` の順に並べた
/// [`DatabaseTables`] へ振り分ける (#1263)。`databases` に無い DB の行は捨て
/// (アクセスできない/システムスキーマ)、行が 1 件も無い DB は空配列で残す。
/// 各 DB 内のテーブルは入力行の順序を保つ。
pub fn group_tables_by_database(
    databases: Vec<String>,
    rows: Vec<(String, String)>,
) -> Vec<DatabaseTables> {
    let mut out: Vec<DatabaseTables> = databases
        .into_iter()
        .map(|database| DatabaseTables {
            database,
            tables: Vec::new(),
        })
        .collect();
    let index: std::collections::HashMap<String, usize> = out
        .iter()
        .enumerate()
        .map(|(i, d)| (d.database.clone(), i))
        .collect();
    for (db, table) in rows {
        if let Some(&i) = index.get(&db) {
            out[i].tables.push(table);
        }
    }
    out
}

#[cfg(test)]
mod group_tables_tests {
    use super::*;

    fn s(v: &str) -> String {
        v.to_string()
    }

    #[test]
    fn groups_rows_in_database_order_and_keeps_empty_databases() {
        let got = group_tables_by_database(
            vec![s("b"), s("a"), s("empty")],
            vec![(s("a"), s("t1")), (s("b"), s("x")), (s("a"), s("t2"))],
        );
        assert_eq!(
            got,
            vec![
                DatabaseTables {
                    database: s("b"),
                    tables: vec![s("x")]
                },
                DatabaseTables {
                    database: s("a"),
                    tables: vec![s("t1"), s("t2")]
                },
                DatabaseTables {
                    database: s("empty"),
                    tables: vec![]
                },
            ]
        );
    }

    #[test]
    fn drops_rows_of_unknown_databases() {
        let got = group_tables_by_database(vec![s("a")], vec![(s("hidden"), s("t"))]);
        assert_eq!(got.len(), 1);
        assert!(got[0].tables.is_empty());
    }
}

#[cfg(test)]
mod js_safe_tests {
    use super::*;

    const SAFE: i64 = JS_MAX_SAFE_INTEGER;

    #[test]
    fn f32_is_widened_through_its_shortest_representation() {
        // `as f64` だと f32 の丸め誤差が見える。最短表記経由なら DB の表示と同じ値になる (#1534)。
        assert_ne!(f64::from(0.1f32), 0.1_f64);
        assert_eq!(Value::from_f32_shortest(0.1), Value::Float(0.1));
        assert_eq!(Value::from_f32_shortest(-2.5), Value::Float(-2.5));
        assert_eq!(Value::from_f32_shortest(0.0), Value::Float(0.0));
        assert_eq!(
            Value::from_f32_shortest(16_777_216.0),
            Value::Float(16_777_216.0)
        );
        assert_eq!(Value::from_f32_shortest(1.0e-7), Value::Float(1.0e-7));
        assert_eq!(
            Value::from_f32_shortest(f32::MAX),
            Value::Float(3.4028235e38)
        );
        // 非有限値はそのまま。
        assert!(matches!(Value::from_f32_shortest(f32::NAN), Value::Float(f) if f.is_nan()));
        assert_eq!(
            Value::from_f32_shortest(f32::INFINITY),
            Value::Float(f64::INFINITY)
        );
    }

    #[test]
    fn lossless_constructors_always_produce_js_safe_values() {
        // 2^53 ± 1 と i64 / u64 / i128 / u128 の端を通し、どの入口からでも
        // 安全範囲外は文字列になる (= is_js_safe) ことを固定する。
        let i64_cases = [
            0,
            1,
            -1,
            SAFE,
            SAFE + 1,
            -SAFE,
            -SAFE - 1,
            i64::MAX,
            i64::MIN,
        ];
        for v in i64_cases {
            let got = Value::from_i64_lossless(v);
            assert!(got.is_js_safe(), "from_i64_lossless({v}) = {got:?}");
            assert_eq!(matches!(got, Value::Int(_)), (-SAFE..=SAFE).contains(&v));
        }
        let u64_cases = [0, SAFE as u64, SAFE as u64 + 1, u64::MAX];
        for v in u64_cases {
            let got = Value::from_u64_lossless(v);
            assert!(got.is_js_safe(), "from_u64_lossless({v}) = {got:?}");
        }
        let i128_cases = [
            SAFE as i128,
            SAFE as i128 + 1,
            -(SAFE as i128) - 1,
            i128::MAX,
            i128::MIN,
        ];
        for v in i128_cases {
            let got = Value::from_i128_lossless(v);
            assert!(got.is_js_safe(), "from_i128_lossless({v}) = {got:?}");
        }
        for v in [SAFE as u128, SAFE as u128 + 1, u128::MAX] {
            let got = Value::from_u128_lossless(v);
            assert!(got.is_js_safe(), "from_u128_lossless({v}) = {got:?}");
        }
    }

    #[test]
    fn is_js_safe_rejects_only_out_of_range_integers() {
        assert!(Value::Int(SAFE).is_js_safe());
        assert!(Value::Int(-SAFE).is_js_safe());
        assert!(!Value::Int(SAFE + 1).is_js_safe());
        assert!(!Value::Int(-SAFE - 1).is_js_safe());
        assert!(!Value::Int(i64::MIN).is_js_safe());
        assert!(Value::UInt(SAFE as u64).is_js_safe());
        assert!(!Value::UInt(SAFE as u64 + 1).is_js_safe());
        assert!(Value::String("9007199254740993".into()).is_js_safe());
        assert!(Value::Float(1e300).is_js_safe());
        assert!(Value::Null.is_js_safe());
    }

    #[test]
    fn debug_assert_js_safe_passes_safe_values_through() {
        assert_eq!(Value::Int(SAFE).debug_assert_js_safe(), Value::Int(SAFE));
        assert_eq!(
            Value::String("x".into()).debug_assert_js_safe(),
            Value::String("x".into())
        );
    }

    #[test]
    #[should_panic(expected = "#1422")]
    fn debug_assert_js_safe_panics_on_out_of_range_int_in_debug_builds() {
        // cargo test は debug_assertions 有効でビルドされる。
        let _ = Value::Int(SAFE + 1).debug_assert_js_safe();
    }

    #[test]
    #[should_panic(expected = "#1422")]
    fn debug_assert_js_safe_panics_on_out_of_range_uint_in_debug_builds() {
        let _ = Value::UInt(u64::MAX).debug_assert_js_safe();
    }

    #[test]
    #[should_panic(expected = "#1780")]
    fn serialize_panics_on_out_of_range_int_in_debug_builds() {
        let _ = serde_json::to_string(&Value::Int(SAFE + 1));
    }

    #[test]
    #[should_panic(expected = "#1780")]
    fn serialize_panics_on_out_of_range_uint_in_debug_builds() {
        let _ = serde_json::to_string(&vec![Value::UInt(u64::MAX)]);
    }

    #[test]
    fn serialize_keeps_json_shape_for_safe_values() {
        assert_eq!(
            serde_json::to_string(&Value::Int(-SAFE)).unwrap(),
            "-9007199254740991"
        );
        assert_eq!(
            serde_json::to_string(&Value::UInt(SAFE as u64)).unwrap(),
            "9007199254740991"
        );
        assert_eq!(
            serde_json::to_string(&Value::from_u64_lossless(u64::MAX)).unwrap(),
            "\"18446744073709551615\""
        );
    }

    /// `Value::Int(` / `Value::UInt(` を直接組み立てる行 (本体コード) を探す。
    /// `#[cfg(test)]` 以降は対象外。`=>` を含む行 (match のパターン) と `matches!` /
    /// `if let` は「読む側」なので対象外。
    fn raw_int_constructions(name: &str, src: &str) -> Vec<String> {
        // 「構築しうる式」の部分だけを返す。match アームは `=>` の右辺、`if let` は `=` の右辺、
        // `matches!` は第 1 引数 (式) だけ。パターン側の `Value::Int(n)` は読む側なので対象外。
        fn expr_zone(code: &str) -> &str {
            if let Some(i) = code.find("=>") {
                &code[i + 2..]
            } else if let Some(i) = code.find("if let") {
                code[i..].split_once(" = ").map_or("", |(_, rhs)| rhs)
            } else if let Some(i) = code.find("matches!(") {
                let rest = &code[i + "matches!(".len()..];
                rest.split(',').next().unwrap_or("")
            } else {
                code
            }
        }
        let mut offenders = Vec::new();
        // `#[cfg(test)]` の次の空でない行が `mod` ならテストモジュールなので打ち切る。
        // それ以外 (テスト専用の fn など) はその項目だけを飛ばして走査を続ける。
        let mut pending_cfg_test = false;
        let mut skip_depth: Option<i32> = None;
        for (no, line) in src.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            let trimmed = code.trim_start();
            if let Some(depth) = skip_depth.as_mut() {
                *depth += code.matches('{').count() as i32 - code.matches('}').count() as i32;
                if *depth <= 0 {
                    skip_depth = None;
                }
                continue;
            }
            if trimmed.starts_with("#[cfg(test)]") {
                pending_cfg_test = true;
                continue;
            }
            if pending_cfg_test {
                if trimmed.is_empty() || trimmed.starts_with("#[") {
                    continue;
                }
                pending_cfg_test = false;
                if trimmed.starts_with("mod ") || trimmed.starts_with("pub mod ") {
                    break;
                }
                let depth = code.matches('{').count() as i32 - code.matches('}').count() as i32;
                if depth > 0 {
                    skip_depth = Some(depth);
                }
                continue;
            }
            let zone = expr_zone(code);
            if zone.contains("Value::Int(") || zone.contains("Value::UInt(") {
                offenders.push(format!("{name}:{}: {}", no + 1, line.trim()));
            }
        }
        offenders
    }

    fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rs_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// `db/**/*.rs` の本体コードに、`Value::Int(` / `Value::UInt(` を直接組み立てる行が
    /// 無いことを固定する (#1422 / #1780)。
    ///
    /// 元の型が 2^53 に収まる場合でも、直接構築の前例があると BIGINT 相当の新しい分岐が
    /// それをコピーして静かに丸めを再発させる。整数は必ず `from_*_lossless` を経由させる。
    /// 唯一の許可は `from_*_lossless` 自身を定義する `types.rs`。ファイル列挙は glob 走査で、
    /// ドライバやモジュールの追加に自動で追従する。
    #[test]
    fn db_modules_never_construct_raw_int_values() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/db");
        let mut files = Vec::new();
        collect_rs_files(&root, &mut files);
        // 走査が空振りして素通りしないよう下限を固定する (db/ には 40 超のモジュールがある)。
        assert!(
            files.len() >= 30,
            "db/**/*.rs の走査結果が少なすぎます: {}",
            files.len()
        );
        let mut offenders = Vec::new();
        for path in &files {
            let rel = path
                .strip_prefix(&root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            if rel == "types.rs" {
                continue;
            }
            let Ok(src) = std::fs::read_to_string(path) else {
                panic!("読み込めません: {rel}");
            };
            offenders.extend(raw_int_constructions(&rel, &src));
        }
        assert!(
            offenders.is_empty(),
            "db/ のモジュールが Value::Int/UInt を直接組み立てています。\
             Value::from_i64_lossless / from_u64_lossless を経由してください (#1422, #1780):\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn raw_int_lint_detects_synthetic_violations_and_ignores_tests() {
        let src = "fn f() -> Value { Value::Int(n) }\nlet _ = Value::UInt(1);\n\
                   match v { Value::Int(i) => i }\nlet s = Value::Int(1); // コメント Value::UInt(\n\
                   #[cfg(test)]\nmod t { fn g() { Value::Int(1); } }\n";
        let hits = raw_int_constructions("x.rs", src);
        assert_eq!(hits.len(), 3, "{hits:?}");
        assert!(hits[0].starts_with("x.rs:1:"));
        assert!(raw_int_constructions("x.rs", "fn f() { Value::from_i64_lossless(1) }").is_empty());
    }

    #[test]
    fn raw_int_lint_checks_match_arm_rhs_and_scans_past_cfg_test_fn() {
        // match アーム右辺での直接構築を検出する (左辺のパターンだけの行は対象外)。
        let hits = raw_int_constructions("x.rs", "Ok(v) => Value::Int(v),\nValue::Int(v) => v,\n");
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].starts_with("x.rs:1:"));
        // if let / matches! は式部分だけを見る。
        assert!(raw_int_constructions("x.rs", "if let Value::Int(n) = v {\n").is_empty());
        assert!(raw_int_constructions("x.rs", "matches!(v, Value::Int(_))\n").is_empty());
        assert_eq!(
            raw_int_constructions("x.rs", "if let Some(n) = Value::Int(1) {\n").len(),
            1
        );
        // 途中の #[cfg(test)] fn の後ろの本体違反を検出し、cfg(test) fn 自身の中身は無視する。
        let src = "#[cfg(test)]\npub fn t() {\n    Value::Int(1);\n}\n\nfn body() {\n    Value::Int(2);\n}\n\
                   #[cfg(test)]\nmod tests {\n    fn x() { Value::Int(3); }\n}\n";
        let hits = raw_int_constructions("x.rs", src);
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert!(hits[0].starts_with("x.rs:7:"), "{hits:?}");
    }

    #[test]
    fn deserialize_moves_out_of_range_integers_to_float() {
        let v: Vec<Value> = serde_json::from_str(
            "[10000000000000000, 9007199254740991, -9007199254740991, 18446744073709551615, -9223372036854775808, 1, 1.5, \"s\", null, true]",
        )
        .unwrap();
        assert_eq!(v[0], Value::Float(1e16));
        assert_eq!(v[1], Value::Int(SAFE));
        assert_eq!(v[2], Value::Int(-SAFE));
        assert_eq!(v[3], Value::Float(u64::MAX as f64));
        assert_eq!(v[4], Value::Float(i64::MIN as f64));
        assert_eq!(v[5], Value::Int(1));
        // 往復しても Serialize の debug_assert に触れない。
        assert!(serde_json::to_string(&v).is_ok());
    }
}

#[cfg(test)]
mod generated_column_tests {
    use super::*;

    fn col(name: &str, extra: &str) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: "int".to_string(),
            nullable: true,
            key: String::new(),
            default: None,
            extra: extra.to_string(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    #[test]
    fn generated_columns_are_detected_from_extra() {
        let cols = vec![
            col("id", "auto_increment"),
            col("a", "STORED GENERATED"),
            col("b", "VIRTUAL GENERATED"),
            col("c", "PERSISTENT GENERATED"),
            col("d", "DEFAULT_GENERATED"),
            col("e", ""),
        ];
        // DEFAULT_GENERATED は式デフォルトで、書き込み可能な通常列。
        assert_eq!(generated_column_names(&cols), vec!["a", "b", "c"]);
    }
}

#[cfg(test)]
mod fk_action_tests {
    use super::*;

    #[test]
    fn normalize_fk_action_drops_default_and_uppercases() {
        assert_eq!(normalize_fk_action(None), None);
        assert_eq!(normalize_fk_action(Some("")), None);
        assert_eq!(normalize_fk_action(Some("no action")), None);
        assert_eq!(
            normalize_fk_action(Some(" cascade ")).as_deref(),
            Some("CASCADE")
        );
        assert_eq!(
            normalize_fk_action(Some("SET NULL")).as_deref(),
            Some("SET NULL")
        );
    }
    #[test]
    fn non_finite_floats_serialize_as_strings_not_null() {
        // serde_json は非有限の f64 を黙って null にするので、手書き Serialize で文字列にする (#1597)。
        assert_eq!(
            serde_json::to_string(&Value::Float(f64::NAN)).unwrap(),
            "\"NaN\""
        );
        assert_eq!(
            serde_json::to_string(&Value::Float(f64::INFINITY)).unwrap(),
            "\"Infinity\""
        );
        assert_eq!(
            serde_json::to_string(&Value::Float(f64::NEG_INFINITY)).unwrap(),
            "\"-Infinity\""
        );
        assert_eq!(serde_json::to_string(&Value::Float(1.5)).unwrap(), "1.5");
        assert_eq!(serde_json::to_string(&Value::Null).unwrap(), "null");
        assert_eq!(serde_json::to_string(&Value::Int(-3)).unwrap(), "-3");
        assert_eq!(
            serde_json::to_string(&Value::Bytes("ab".into())).unwrap(),
            "\"ab\""
        );
    }
}

/// SQLite のメンテナンス操作 (#1625)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqliteMaintenanceAction {
    /// `PRAGMA integrity_check` (読み取りのみ)。
    IntegrityCheck,
    /// `PRAGMA foreign_key_check` (読み取りのみ)。
    ForeignKeyCheck,
    /// `PRAGMA optimize` (統計の更新を伴うため書き込み扱い)。
    Optimize,
    /// `ANALYZE` (統計表 `sqlite_stat1` を更新するため書き込み扱い)。
    Analyze,
}

impl SqliteMaintenanceAction {
    /// 読み取り専用セッションで実行してはいけない操作か。
    pub fn writes(self) -> bool {
        matches!(self, Self::Optimize | Self::Analyze)
    }
}

/// `PRAGMA foreign_key_check` が返す参照整合性違反 1 件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SqliteFkViolation {
    /// 違反した行を持つ表 (子表)。
    pub table: String,
    /// 違反した行の rowid。`WITHOUT ROWID` 表では `None`。
    pub rowid: Option<i64>,
    /// 参照先の表 (親表)。
    pub parent: String,
    /// `PRAGMA foreign_key_list` 上の外部キー番号。
    pub fk_index: i64,
}

/// SQLite メンテナンスの実行結果 (#1625)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SqliteMaintenanceResult {
    pub action: SqliteMaintenanceAction,
    /// 問題が無かったか (`integrity_check` は `ok` のみ、`foreign_key_check` は違反 0 件。
    /// `optimize` / `analyze` は実行できたら true)。
    pub ok: bool,
    /// `integrity_check` が返したメッセージ (破損の説明)。`ok` のときは空。
    pub messages: Vec<String>,
    /// `foreign_key_check` の違反行 (先頭 [`SQLITE_MAINTENANCE_MAX_ROWS`] 件)。
    pub fk_violations: Vec<SqliteFkViolation>,
    /// 結果を件数上限で切り詰めたか。
    pub truncated: bool,
    /// 実行後の `PRAGMA page_count` (VACUUM / ANALYZE の要否判断用)。
    pub page_count: Option<i64>,
    /// 実行後の `PRAGMA freelist_count` (空きページ数。多いなら VACUUM の候補)。
    pub freelist_count: Option<i64>,
    pub elapsed_ms: u64,
}

/// メンテナンス結果に載せる行数の上限。
pub const SQLITE_MAINTENANCE_MAX_ROWS: usize = 1000;

/// PostgreSQL の `CREATE TABLE` 再構成に足す、列情報だけでは分からない定義 (#1625)。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TableDdlExtras {
    /// CHECK 制約 (制約名, `pg_get_constraintdef` の出力 = `CHECK (...)` 句全体)。
    pub checks: Vec<(String, String)>,
    /// 生成列 (列名, `pg_get_expr(adbin)` の生成式, VIRTUAL か。false は STORED)。
    pub generated: Vec<(String, String, bool)>,
}
