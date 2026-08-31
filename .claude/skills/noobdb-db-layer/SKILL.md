---
name: noobdb-db-layer
description: noobDB の DB ドライバ層 (src-tauri/src/db/) を変更するとき、新しいドライバや列型を追加するとき、enum Connection のディスパッチ・MSSQL (tiberius) の手書きプール・TLS/SSL 設定・セッション初期化 SQL・値のデコード規約を調べるときに読む。
---

# noobDB の DB ドライバ層 (`src-tauri/src/db/`)

対応ドライバは **MySQL / PostgreSQL / SQLite / DuckDB / Microsoft SQL Server** の
5 つ。ディスパッチはトレイトオブジェクトではなく**手書きの `enum Connection`**
(`db/mod.rs`) です。

## ドライバを追加・変更するときの手順

1. `DriverKind` にバリアントを追加する。
2. `db/<name>.rs` を追加し、既存ドライバと**同じメソッド表面**を実装する。
3. `db/mod.rs` の**全 `match` アーム**を拡張する (漏れるとコンパイルエラー)。
4. SSH / セッション層には**触らない** — ドライバ非依存です。

## 必ず守る不変条件

- **64bit 整数は `Value::from_i64_lossless` / `from_u64_lossless` /
  `from_i128_lossless` / `from_u128_lossless` を必ず経由する。** `Value` は
  `#[serde(untagged)]` なので素の JSON 数値になり、`Number.MAX_SAFE_INTEGER` を
  超えると丸められます。表示が狂うだけでなく、インラインセル編集が丸めた値で
  `WHERE pk = ...` を組み立て、**意図しない行を書き換えます。**
- **PostgreSQL のデコードは「非 NULL の値を `Value::Null` にしない」** ことを
  不変条件とします。素朴なフォールバックだと uuid・配列・inet などが NULL に
  化け、Diff/Sync が実差分を見逃します。最終フォールバックは
  `try_get_unchecked` で、`Value::Null` を返すのは **SQL NULL のときだけ**。
- 列型を追加するときは「型付きで試して失敗したら String にフォールバック」の
  既存パターンに従う。

## 参照

| ファイル | 内容 |
|---|---|
| `references/drivers.md` | `enum Connection` のメソッド表面、MSSQL (tiberius) の手書きプールと「疑わしい接続は捨てる」方針、整数/PostgreSQL のデコード規約、`is_query_shape` |
| `references/tls.md` | `SslMode` とドライバ別マッピング、証明書はパスのみ保存、TLS 統合テストの CI 配備 |
| `references/session-init-sql.md` | `after_connect` フックでの初期化 SQL と読み取り専用との整合 |

安全網 (`is_read_only_sql` / `apply_auto_limit`) は `noobdb-sql-safety` スキルへ。
