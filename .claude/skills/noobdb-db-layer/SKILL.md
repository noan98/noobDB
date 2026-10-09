---
name: noobdb-db-layer
description: noobDB の DB ドライバ層 (src-tauri/src/db/) を変更するとき、列型やドライバ別の機能を 3 ドライバ (MySQL/PostgreSQL/SQLite) に揃えて追加するとき、enum Connection のディスパッチ・TLS/SSL 設定・セッション初期化 SQL・値のデコード規約を調べるときに読む。
---

# noobDB の DB ドライバ層 (`src-tauri/src/db/`)

対応ドライバは **MySQL / PostgreSQL / SQLite** の 3 つ。ディスパッチはトレイト
オブジェクトではなく**手書きの `enum Connection`** (`db/mod.rs`) です。

## ドライバ別の機能を追加・変更するときの手順

`DriverKind` は `Mysql` / `Postgres` / `Sqlite` の 3 バリアントで**固定**です。新しい
ドライバは追加しません (`.claude/rules/issues-and-prs.md`)。

1. 既存の `db/<mysql|postgres|sqlite>.rs` の 3 つに**同じメソッド表面**で実装する。
2. `db/mod.rs` の**全 `match` アーム**で 3 ドライバを揃える (漏れるとコンパイルエラー)。
3. SSH / セッション層には**触らない** — ドライバ非依存です。

## 必ず守る不変条件

- **64bit 整数は `Value::from_i64_lossless` / `from_u64_lossless` /
  `from_i128_lossless` / `from_u128_lossless` を必ず経由する。** `Value` は
  `#[serde(untagged)]` なので素の JSON 数値になり、`Number.MAX_SAFE_INTEGER` を
  超えると丸められます。表示が狂うだけでなく、インラインセル編集が丸めた値で
  `WHERE pk = ...` を組み立て、**意図しない行を書き換えます。** デコーダ本体で
  `Value::Int(` / `Value::UInt(` を直接組み立てると静的ガードで、安全範囲外を返すと
  `decode_cell` の `debug_assert_js_safe` でテストが落ちます (#1422)。
- **PostgreSQL のデコードは「非 NULL の値を `Value::Null` にしない」** ことを
  不変条件とします。素朴なフォールバックだと uuid・配列・inet などが NULL に
  化け、Diff/Sync が実差分を見逃します。最終フォールバックは
  `try_get_unchecked` で、`Value::Null` を返すのは **SQL NULL のときだけ**。
- 列型を追加するときは「型付きで試して失敗したら String にフォールバック」の
  既存パターンに従う。

## 参照

| ファイル | 内容 |
|---|---|
| `references/drivers.md` | `enum Connection` のメソッド表面、整数/PostgreSQL のデコード規約、`is_query_shape` |
| `references/tls.md` | `SslMode` とドライバ別マッピング、証明書はパスのみ保存、TLS 統合テストの CI 配備 |
| `references/session-init-sql.md` | `after_connect` フックでの初期化 SQL と読み取り専用との整合 |

安全網 (`is_read_only_sql` / `apply_auto_limit`) は `noobdb-sql-safety` スキルへ。
