//! エクスポート時のデータマスキング (#733) の純粋層。
//!
//! 本番データを開発環境や外部共有向けに書き出すとき、PII 列 (氏名・メール・電話番号
//! など) を**出力時にだけ**変換する。DB 内のデータには一切触れない (UPDATE は発行
//! しない)。変換はここに集約した副作用なしの純関数で、`commands/export.rs` の
//! 「値エンコード直前」の単一フック ([`MaskPlan::apply_rows`]) から、在グリッド /
//! ストリーミングの両経路・6 形式 (xlsx #711 を含む) すべてに同じ形で効く。
//!
//! ## ルール ([`MaskRule`])
//!
//! | kind | 変換 |
//! |---|---|
//! | `fixed` | 固定値 (既定 `***`) へ置換 |
//! | `partial` | 先頭 `keepStart` / 末尾 `keepEnd` 文字を残し、間を `*` にする (長さは保存) |
//! | `hash` | HMAC-SHA256(ソルト, 値) の 16 進先頭 `length` 文字 (仮名化) |
//! | `null` | NULL にする |
//!
//! ## 境界の扱い
//!
//! - **NULL はどのルールでも NULL のまま。** NULL であること自体は PII ではなく、
//!   `***` などに置き換えると NULL 率が変わって出力先での分析を誤らせるため。
//! - 文字数は **Unicode スカラ値 (コードポイント) 単位**で数える (JS の
//!   `Array.from(s)` と同じ)。マルチバイト文字の途中で切れることはない。
//! - 数値・真偽値は文字列表現 (`42` / `1.5` / `true`) に対して変換し、`fixed` /
//!   `partial` / `hash` の結果は文字列になる。
//! - BLOB (`Value::Bytes`) は 16 進文字列そのものを変換対象にする。在グリッド経路では
//!   BLOB が IPC を跨いだ時点で素の 16 進文字列 (`Value::String`) になるため、両経路で
//!   **同じ入力文字列**を見ることになり、`hash` の出力も両経路で一致する。
//!
//! ## 仮名化 (`hash`) のソルト
//!
//! 同一入力 → 同一出力 (結合キーとして使える) を保ちつつ、`SHA-256("alice@example.com")`
//! のような辞書攻撃で元の値を引けないよう、**アプリ単位の秘密ソルトを鍵にした HMAC**
//! を使う。ソルトは初回利用時に乱数で生成して **OS keyring にのみ**保存する
//! (`profiles::secrets::get_or_create_export_mask_salt`)。`profiles.json`・設定・ログ・
//! フロントエンドには一切出さない。プレビューもフロントで計算せず、バックエンドの
//! `mask_export_rows` を通すのはこのため。ソルトはプロファイル非依存なので、別の
//! 接続から書き出したファイル同士でも同じ値は同じ仮名になる。
//!
//! ルールの正規化 (上限・既定値) と各ルールの出力はフロントとの共有ゴールデン
//! `src/__tests__/fixtures/exportMaskingVectors.json` で固定している
//! (フロントの `components/exportMasking.ts::sanitizeMaskRule` がルールを保存・送信
//! する前に同じ正規化を掛ける)。

use std::borrow::Cow;

use data_encoding::HEXLOWER;
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::db::types::{Column, Value};
use crate::error::{AppError, Result};

/// `fixed` ルールの既定の置換文字列。
pub const DEFAULT_FIXED_VALUE: &str = "***";
/// `fixed` ルールの置換文字列の最大文字数。
pub const MAX_FIXED_VALUE_CHARS: usize = 200;
/// `partial` ルールで伏せる 1 文字あたりの記号。
pub const PARTIAL_MASK_CHAR: char = '*';
/// `partial` ルールで残せる先頭 / 末尾の最大文字数 (それぞれ)。
pub const MAX_KEEP_CHARS: usize = 64;
/// `hash` ルールの既定の出力長 (16 進文字数)。
pub const DEFAULT_HASH_LENGTH: usize = 16;
/// `hash` ルールの出力長の下限。短すぎると衝突して結合キーに使えなくなる。
pub const MIN_HASH_LENGTH: usize = 4;
/// `hash` ルールの出力長の上限 (SHA-256 の 16 進全長)。
pub const MAX_HASH_LENGTH: usize = 64;
/// 1 回のエクスポートで指定できるマスク列数の上限 (IPC 経由の異常入力への耐性)。
pub const MAX_COLUMN_MASKS: usize = 1000;

fn default_fixed_value() -> String {
    DEFAULT_FIXED_VALUE.to_string()
}

fn default_hash_length() -> usize {
    DEFAULT_HASH_LENGTH
}

/// 1 列に掛けるマスキングルール。IPC では `{ "kind": "partial", "keepStart": 2, ... }`
/// の形で受け取る (フロントの `ExportMaskRule` と同形)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MaskRule {
    /// 固定値置換。
    Fixed {
        #[serde(default = "default_fixed_value")]
        value: String,
    },
    /// 部分マスク。先頭 `keep_start` / 末尾 `keep_end` 文字を残し、間を `*` にする。
    Partial {
        #[serde(default, rename = "keepStart")]
        keep_start: usize,
        #[serde(default, rename = "keepEnd")]
        keep_end: usize,
    },
    /// HMAC-SHA256 による仮名化 (16 進の先頭 `length` 文字)。
    Hash {
        #[serde(default = "default_hash_length")]
        length: usize,
    },
    /// NULL 化。
    Null,
}

impl MaskRule {
    /// 上限・既定値を適用した正規形にする。フロントの `sanitizeMaskRule` と同じ規則
    /// (共有ゴールデンで固定):
    /// - `fixed`: 前後の空白は保持し、`MAX_FIXED_VALUE_CHARS` 文字で切り詰める。
    ///   空文字列は「空へ置換」として許す。
    /// - `partial`: `keepStart` / `keepEnd` をそれぞれ `MAX_KEEP_CHARS` で頭打ち。
    /// - `hash`: `length` を `[MIN_HASH_LENGTH, MAX_HASH_LENGTH]` に収める。
    pub fn normalized(&self) -> MaskRule {
        match self {
            MaskRule::Fixed { value } => MaskRule::Fixed {
                value: value.chars().take(MAX_FIXED_VALUE_CHARS).collect(),
            },
            MaskRule::Partial {
                keep_start,
                keep_end,
            } => MaskRule::Partial {
                keep_start: (*keep_start).min(MAX_KEEP_CHARS),
                keep_end: (*keep_end).min(MAX_KEEP_CHARS),
            },
            MaskRule::Hash { length } => MaskRule::Hash {
                length: (*length).clamp(MIN_HASH_LENGTH, MAX_HASH_LENGTH),
            },
            MaskRule::Null => MaskRule::Null,
        }
    }

    fn is_hash(&self) -> bool {
        matches!(self, MaskRule::Hash { .. })
    }
}

/// 列名 → ルールの指定 1 件。列は**名前の完全一致**で対応付ける (ストリーミング経路は
/// 列が実行時まで分からないため、インデックスではなく名前で受け取る)。同名の列が
/// 複数あるとき (JOIN の `id` など) はすべてに同じルールが掛かる。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnMask {
    pub column: String,
    pub rule: MaskRule,
}

/// 検証済みのマスキング指定 (列ごとのルール + 必要ならソルト)。列がまだ分からない
/// ストリーミング経路では、これを持っておき `columns` イベントで [`MaskSpec::plan`]
/// を作る。
#[derive(Debug, Clone)]
pub struct MaskSpec {
    masks: Vec<ColumnMask>,
    salt: Vec<u8>,
}

impl MaskSpec {
    /// ルールを正規化して検証する。`hash` ルールがあるのにソルトが無い (または空) なら
    /// エラー — ソルト無しの素の SHA-256 へ黙って縮退すると辞書攻撃で元の値を引ける
    /// 仮名になってしまうため、**マスクせずに書き出すのではなく失敗させる** (fail closed)。
    pub fn new(masks: Vec<ColumnMask>, salt: Option<Vec<u8>>) -> Result<Self> {
        if masks.len() > MAX_COLUMN_MASKS {
            return Err(AppError::InvalidInput(format!(
                "too many masked columns (max {MAX_COLUMN_MASKS})"
            )));
        }
        let masks: Vec<ColumnMask> = masks
            .into_iter()
            .map(|m| ColumnMask {
                column: m.column,
                rule: m.rule.normalized(),
            })
            .collect();
        let salt = salt.unwrap_or_default();
        if masks.iter().any(|m| m.rule.is_hash()) && salt.is_empty() {
            return Err(AppError::InvalidInput(
                "hash masking requires a salt from the OS keyring".into(),
            ));
        }
        Ok(Self { masks, salt })
    }

    /// 列一覧に対してルールを解決した適用計画を作る。
    pub fn plan(&self, columns: &[Column]) -> MaskPlan {
        let rules = columns
            .iter()
            .map(|c| {
                self.masks
                    .iter()
                    .find(|m| m.column == c.name)
                    .map(|m| m.rule.clone())
            })
            .collect();
        MaskPlan {
            rules,
            salt: self.salt.clone(),
        }
    }
}

/// 指定のうち `hash` ルールを含むか (= keyring からソルトを取る必要があるか)。
pub fn needs_salt(masks: &[ColumnMask]) -> bool {
    masks.iter().any(|m| m.rule.is_hash())
}

/// 列インデックス順に解決済みのルール列。
#[derive(Debug, Clone)]
pub struct MaskPlan {
    rules: Vec<Option<MaskRule>>,
    salt: Vec<u8>,
}

impl MaskPlan {
    /// マスクされる列の数。
    pub fn masked_count(&self) -> usize {
        self.rules.iter().filter(|r| r.is_some()).count()
    }

    /// 1 行を変換する。ルールの無い列はそのまま複製する。
    pub fn apply_row(&self, row: &[Value]) -> Vec<Value> {
        row.iter()
            .enumerate()
            .map(|(i, v)| match self.rules.get(i).and_then(|r| r.as_ref()) {
                Some(rule) => mask_value(rule, v, &self.salt),
                None => v.clone(),
            })
            .collect()
    }

    /// 行の束を変換する。マスク列が 1 つも無ければ複製せず借用のまま返す
    /// (マスキング無効時のエクスポートに余計なアロケーションを足さない)。
    pub fn apply_rows<'a>(&self, rows: &'a [Vec<Value>]) -> Cow<'a, [Vec<Value>]> {
        if self.masked_count() == 0 {
            return Cow::Borrowed(rows);
        }
        Cow::Owned(rows.iter().map(|r| self.apply_row(r)).collect())
    }

    /// マスク後の値に合わせた列定義を返す。マスクした列は変換後が文字列 (または
    /// NULL) なので、型名による推定 (xlsx の `is_numeric_type`、#711) を効かせない
    /// よう型名を [`MASKED_COLUMN_TYPE`] に置き換える。これをしないと、数値列を
    /// `hash` で仮名化した結果がたまたま数字だけのとき xlsx で数値セルになり、先頭の
    /// `0` が落ちて他形式と別の仮名になる。マスク列が無ければ借用のまま返す。
    pub fn output_columns<'a>(&self, columns: &'a [Column]) -> Cow<'a, [Column]> {
        if self.masked_count() == 0 {
            return Cow::Borrowed(columns);
        }
        Cow::Owned(
            columns
                .iter()
                .enumerate()
                .map(|(i, c)| match self.rules.get(i).and_then(|r| r.as_ref()) {
                    Some(_) => Column {
                        name: c.name.clone(),
                        type_name: MASKED_COLUMN_TYPE.into(),
                    },
                    None => c.clone(),
                })
                .collect(),
        )
    }
}

/// マスク後の列に付ける型名 ([`MaskPlan::output_columns`])。数値型と誤認されない
/// 文字列型の名前にする。
pub const MASKED_COLUMN_TYPE: &str = "TEXT";

/// 計画が無ければ借用のまま返す [`MaskPlan::output_columns`]。
pub fn mask_columns<'a>(plan: Option<&MaskPlan>, columns: &'a [Column]) -> Cow<'a, [Column]> {
    match plan {
        Some(p) => p.output_columns(columns),
        None => Cow::Borrowed(columns),
    }
}

/// エクスポートの単一フック。計画が無ければ借用のまま返す。在グリッド
/// (`write_export_to`) とストリーミング (`StreamExportSink::on_rows`) の両経路が
/// これを通ってから各形式のエンコーダへ渡す。
pub fn mask_rows<'a>(plan: Option<&MaskPlan>, rows: &'a [Vec<Value>]) -> Cow<'a, [Vec<Value>]> {
    match plan {
        Some(p) => p.apply_rows(rows),
        None => Cow::Borrowed(rows),
    }
}

/// 変換対象の文字列表現。NULL は呼び出し側で先に除外する。
fn source_text(v: &Value) -> Cow<'_, str> {
    match v {
        Value::Null => Cow::Borrowed(""),
        Value::Bool(b) => Cow::Owned(b.to_string()),
        Value::Int(i) => Cow::Owned(i.to_string()),
        Value::UInt(u) => Cow::Owned(u.to_string()),
        Value::Float(f) => Cow::Owned(f.to_string()),
        Value::String(s) | Value::Bytes(s) => Cow::Borrowed(s.as_str()),
    }
}

/// 値 1 つにルールを適用する (純関数)。`salt` は `hash` ルールでのみ使う。
pub fn mask_value(rule: &MaskRule, v: &Value, salt: &[u8]) -> Value {
    if matches!(v, Value::Null) {
        return Value::Null;
    }
    match rule {
        MaskRule::Null => Value::Null,
        MaskRule::Fixed { value } => Value::String(value.clone()),
        MaskRule::Partial {
            keep_start,
            keep_end,
        } => Value::String(partial_mask(&source_text(v), *keep_start, *keep_end)),
        MaskRule::Hash { length } => Value::String(pseudonymize(&source_text(v), salt, *length)),
    }
}

/// 先頭 `keep_start` / 末尾 `keep_end` 文字 (コードポイント単位) を残し、間を `*` に
/// する。長さは保存する。残す文字数の合計が全長以上のときは**全文字を伏せる**
/// (短い値をそのまま漏らさないため)。
pub fn partial_mask(s: &str, keep_start: usize, keep_end: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    if keep_start.saturating_add(keep_end) >= n {
        return std::iter::repeat(PARTIAL_MASK_CHAR).take(n).collect();
    }
    let mut out = String::with_capacity(s.len());
    out.extend(&chars[..keep_start]);
    out.extend(std::iter::repeat(PARTIAL_MASK_CHAR).take(n - keep_start - keep_end));
    out.extend(&chars[n - keep_end..]);
    out
}

/// HMAC-SHA256(`salt`, `s`) の小文字 16 進の先頭 `length` 文字。`length` は
/// `[MIN_HASH_LENGTH, MAX_HASH_LENGTH]` に収める。
pub fn pseudonymize(s: &str, salt: &[u8], length: usize) -> String {
    let length = length.clamp(MIN_HASH_LENGTH, MAX_HASH_LENGTH);
    // HMAC は任意長の鍵を受け付ける (ブロック長超はハッシュ、未満はゼロ詰め) ので
    // `new_from_slice` が失敗することは無いが、unwrap を避けて素の SHA-256 相当へは
    // 縮退させずに空鍵の HMAC を使う (MaskSpec が空ソルトの hash を事前に拒否する
    // ため、ここに到達するのは不変条件が破れたときだけ)。
    let digest = match <Hmac<Sha256> as KeyInit>::new_from_slice(salt) {
        Ok(mut mac) => {
            mac.update(s.as_bytes());
            mac.finalize().into_bytes().to_vec()
        }
        Err(_) => Vec::new(),
    };
    let mut hex = HEXLOWER.encode(&digest);
    hex.truncate(length);
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: "TEXT".into(),
        }
    }

    // ── 共有ゴールデン (フロントの exportMaskingGolden.test.ts と同じベクタ) ──

    const VECTORS_JSON: &str =
        include_str!("../../../src/__tests__/fixtures/exportMaskingVectors.json");

    #[derive(Deserialize)]
    struct Vectors {
        salt: String,
        cases: Vec<Case>,
        normalize: Vec<NormalizeCase>,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        rule: MaskRule,
        input: CellSpec,
        expected: serde_json::Value,
    }

    #[derive(Deserialize)]
    struct NormalizeCase {
        name: String,
        rule: MaskRule,
        normalized: MaskRule,
    }

    #[derive(Deserialize)]
    struct CellSpec {
        kind: String,
        #[serde(default)]
        value: serde_json::Value,
    }

    fn cell(spec: &CellSpec) -> Value {
        let v = &spec.value;
        match spec.kind.as_str() {
            "null" => Value::Null,
            "bool" => Value::Bool(v.as_bool().unwrap_or_default()),
            "int" => Value::Int(v.as_i64().unwrap_or_default()),
            "uint" => Value::UInt(v.as_u64().unwrap_or_default()),
            "float" => Value::Float(v.as_f64().unwrap_or_default()),
            "string" => Value::String(v.as_str().unwrap_or_default().to_string()),
            "bytes" => Value::Bytes(v.as_str().unwrap_or_default().to_string()),
            other => panic!("unknown cell kind {other}"),
        }
    }

    fn to_json(v: &Value) -> serde_json::Value {
        match v {
            Value::Null => serde_json::Value::Null,
            Value::Bool(b) => serde_json::Value::Bool(*b),
            Value::Int(i) => serde_json::json!(i),
            Value::UInt(u) => serde_json::json!(u),
            Value::Float(f) => serde_json::json!(f),
            Value::String(s) | Value::Bytes(s) => serde_json::Value::String(s.clone()),
        }
    }

    #[test]
    fn golden_vectors_match() {
        let vectors: Vectors = serde_json::from_str(VECTORS_JSON).expect("valid vectors");
        assert!(!vectors.cases.is_empty());
        let salt = vectors.salt.as_bytes();
        for case in &vectors.cases {
            let got = mask_value(&case.rule.normalized(), &cell(&case.input), salt);
            assert_eq!(to_json(&got), case.expected, "case {}", case.name);
        }
    }

    #[test]
    fn golden_normalization_matches() {
        let vectors: Vectors = serde_json::from_str(VECTORS_JSON).expect("valid vectors");
        assert!(!vectors.normalize.is_empty());
        for case in &vectors.normalize {
            assert_eq!(
                case.rule.normalized(),
                case.normalized,
                "case {}",
                case.name
            );
        }
    }

    // ── 個別の境界 ──

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        // RFC 4231 Test Case 2: key = "Jefe", data = "what do ya want for nothing?"
        let full = pseudonymize("what do ya want for nothing?", b"Jefe", MAX_HASH_LENGTH);
        assert_eq!(
            full,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hash_is_deterministic_and_salt_dependent() {
        let a = pseudonymize("alice@example.com", b"salt-1", 16);
        let b = pseudonymize("alice@example.com", b"salt-1", 16);
        let c = pseudonymize("alice@example.com", b"salt-2", 16);
        let d = pseudonymize("bob@example.com", b"salt-1", 16);
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
        assert_eq!(a.len(), 16);
    }

    #[test]
    fn hash_length_is_clamped() {
        assert_eq!(pseudonymize("x", b"s", 0).len(), MIN_HASH_LENGTH);
        assert_eq!(pseudonymize("x", b"s", 1000).len(), MAX_HASH_LENGTH);
    }

    #[test]
    fn int_and_numeric_string_share_a_pseudonym() {
        // 片方のテーブルが INT、もう片方が文字列のキーでも同じ仮名になり結合できる。
        let r = MaskRule::Hash { length: 16 };
        assert_eq!(
            mask_value(&r, &Value::Int(42), b"s"),
            mask_value(&r, &Value::String("42".into()), b"s")
        );
    }

    #[test]
    fn partial_mask_counts_code_points() {
        assert_eq!(partial_mask("山田太郎", 1, 1), "山**郎");
        assert_eq!(partial_mask("a😀b😀c", 1, 1), "a***c");
        assert_eq!(partial_mask("abc", 2, 2), "***");
        assert_eq!(partial_mask("", 1, 1), "");
        assert_eq!(partial_mask("abcdef", 0, 0), "******");
        assert_eq!(partial_mask("abcdef", usize::MAX, usize::MAX), "******");
    }

    #[test]
    fn null_stays_null_for_every_rule() {
        for rule in [
            MaskRule::Fixed {
                value: "***".into(),
            },
            MaskRule::Partial {
                keep_start: 1,
                keep_end: 1,
            },
            MaskRule::Hash { length: 8 },
            MaskRule::Null,
        ] {
            assert_eq!(mask_value(&rule, &Value::Null, b"s"), Value::Null);
        }
    }

    #[test]
    fn spec_rejects_hash_without_salt() {
        let masks = vec![ColumnMask {
            column: "email".into(),
            rule: MaskRule::Hash { length: 8 },
        }];
        assert!(needs_salt(&masks));
        assert!(MaskSpec::new(masks.clone(), None).is_err());
        assert!(MaskSpec::new(masks.clone(), Some(Vec::new())).is_err());
        assert!(MaskSpec::new(masks, Some(b"k".to_vec())).is_ok());
    }

    #[test]
    fn spec_without_hash_needs_no_salt() {
        let masks = vec![ColumnMask {
            column: "email".into(),
            rule: MaskRule::Null,
        }];
        assert!(!needs_salt(&masks));
        assert!(MaskSpec::new(masks, None).is_ok());
    }

    #[test]
    fn spec_rejects_too_many_masks() {
        let masks = (0..=MAX_COLUMN_MASKS)
            .map(|i| ColumnMask {
                column: format!("c{i}"),
                rule: MaskRule::Null,
            })
            .collect();
        assert!(MaskSpec::new(masks, None).is_err());
    }

    #[test]
    fn plan_matches_columns_by_exact_name_including_duplicates() {
        let spec = MaskSpec::new(
            vec![ColumnMask {
                column: "id".into(),
                rule: MaskRule::Fixed { value: "X".into() },
            }],
            None,
        )
        .expect("valid spec");
        let plan = spec.plan(&[col("id"), col("ID"), col("name"), col("id")]);
        assert_eq!(plan.masked_count(), 2);
        let row = vec![
            Value::Int(1),
            Value::Int(2),
            Value::String("n".into()),
            Value::Int(3),
        ];
        assert_eq!(
            plan.apply_row(&row),
            vec![
                Value::String("X".into()),
                Value::Int(2),
                Value::String("n".into()),
                Value::String("X".into()),
            ]
        );
    }

    #[test]
    fn apply_rows_borrows_when_nothing_is_masked() {
        let spec = MaskSpec::new(Vec::new(), None).expect("valid spec");
        let plan = spec.plan(&[col("a")]);
        let rows = vec![vec![Value::Int(1)]];
        assert!(matches!(plan.apply_rows(&rows), Cow::Borrowed(_)));
        assert!(matches!(mask_rows(None, &rows), Cow::Borrowed(_)));
    }

    #[test]
    fn rule_deserializes_from_frontend_shape() {
        let r: MaskRule =
            serde_json::from_str(r#"{"kind":"partial","keepStart":2,"keepEnd":3}"#).expect("ok");
        assert_eq!(
            r,
            MaskRule::Partial {
                keep_start: 2,
                keep_end: 3
            }
        );
        let r: MaskRule = serde_json::from_str(r#"{"kind":"hash"}"#).expect("ok");
        assert_eq!(
            r,
            MaskRule::Hash {
                length: DEFAULT_HASH_LENGTH
            }
        );
        let r: MaskRule = serde_json::from_str(r#"{"kind":"fixed"}"#).expect("ok");
        assert_eq!(
            r,
            MaskRule::Fixed {
                value: DEFAULT_FIXED_VALUE.into()
            }
        );
        assert!(serde_json::from_str::<MaskRule>(r#"{"kind":"rot13"}"#).is_err());
    }
}
