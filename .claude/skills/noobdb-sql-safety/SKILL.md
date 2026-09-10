---
name: noobdb-sql-safety
description: noobDB の SQL 安全網を変更するとき — 読み取り専用ガード (is_read_only_sql)、自動 LIMIT/TOP 挿入、コメント/文字列リテラルのマスク、危険クエリ検出、そして Rust とフロントの二重実装を固定する共有ゴールデンベクタ (src/__tests__/fixtures/*.json) を扱うときに読む。
---

# noobDB の SQL 安全網

`db/mod.rs` の `is_read_only_sql` / `apply_auto_limit` と、フロントの
`dangerousSql.ts` は**ベストエフォートの安全網であってパーサではありません**。
迷ったら安全側 (fail-closed) に倒すのが一貫した方針です。

## 変更するときに必ずやること

1. **共有ゴールデンベクタに境界ケースを追記する。** 判定は Rust とフロントで
   独立に二重実装されているため、片方だけ変えるとズレます。

   | フィクスチャ | 固定する対象 |
   |---|---|
   | `readOnlySqlVectors.json` | `is_read_only_sql` / `isReadOnlySql` |
   | `maskVectors.json` | コメント/リテラルのマスク (全判定の土台) |
   | `autoLimitVectors.json` | `apply_auto_limit_for` (5 ドライバ) |
   | `queryShapeVectors.json` | fetch/execute 経路の振り分け |
   | `sqlQuotingVectors.json` | 識別子引用・リテラルエスケープ |

2. **マスクはドライバ別**である点を忘れない。バックスラッシュをエスケープ文字と
   見なすのは **MySQL/MariaDB だけ**です。ドライバを知っている呼び出し口は
   `*_for(driver, ...)` を使い、知らない口は保守的な
   `mask_for_analysis_conservative` に倒します。

## 安全網の「強制レベル」を混同しない

| 仕組み | 強制レベル |
|---|---|
| `read_only` (プロファイル) | **バックエンド強制**。IPC を直接叩いても書き込めない |
| 緊急クエリ実行モード | `read_only` の唯一のランタイム例外。セッション在命中のみ |
| `confirm_writes` / `is_production` | **UI レベルの誤操作防止のみ**。IPC 直叩きで素通り |
| フライトレコーダー (#735) | ベストエフォートのローカル保険。捕捉に失敗しても書き込みは通る |

確実に書き込みを禁止したい場合は `read_only` か DB 側の権限設定を併用します。

詳細 (許可リスト、キーワード許可リストでは見えない書き込み経路、MSSQL の
ロックヒント、DuckDB の条件付き許可、各ゴールデンの設計) は
`references/details.md` を参照。
