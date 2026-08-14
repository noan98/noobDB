// ドライラン (プレビュー) の BEFORE/AFTER スナップショットを組み立てる、
// **ドライバ非依存な純粋ロジック**。
//
// 各ドライバの `preview_execute_with_limit` は「BEFORE を撮る → 対象 SQL を
// トランザクション内で実行 → AFTER を撮る → ロールバック」という同じ骨格を
// 持つ。その中で SQL テキストを読み書きするだけの部分 —
//
//   * ユーザの WHERE 句を切り出して BEFORE スナップショットへ反映する
//     ([`extract_where_and_after`] / [`before_where_clause`])
//   * スナップショット用の `SELECT * FROM ...` を組み立てる
//     ([`build_snapshot_sql`])
//   * BEFORE で捕まえた主キーで AFTER を取り直す `IN` 句を組み立てる
//     ([`build_after_by_pk_sql`])
//
// — は方言差が「識別子の引用規則」と「値の埋め方 (プレースホルダ / リテラル)」
// だけなので、ここへ集約して MySQL / PostgreSQL の双方から使う。
//
// 元はこの一式が `db::mysql` にしか無く、PostgreSQL 側は常に
// `SELECT * FROM t ORDER BY pk LIMIT n+1` の固定窓を撮っていた。そのため更新
// 対象が PK 昇順の先頭 N 件の外にあると before/after が同一になり、差分が
// 「変更なし」に見える (実際には書き換わっているのに気付けない) という
// 取りこぼしがあった。共有化はその修正のためでもある。
//
// ここにあるのは文字列処理だけで、DB へは触らない (sqlx の型に依存しない) ため、
// 下の単体テストが実サーバ無しで境界を固定できる。

use super::SqlFlavor;

/// `sql` のうち、**トップレベル**の `WHERE` キーワード以降 (キーワード自身を
/// 含む) を返す。トップレベルに `WHERE` が無ければ `None`。
///
/// コメントを先に除去したうえで、文字列リテラル・引用付き識別子
/// (`'…'` / `"…"` / MySQL の `` `…` `` / PostgreSQL のドル引用 `$tag$…$tag$`) と
/// 括弧の深さを追跡するので、サブクエリの中の `WHERE` (例: `UPDATE` の `SET`
/// 式に埋まった `SELECT … WHERE …`) や、文字列/識別子の中に現れる `where` を
/// 外側の句と取り違えない。
///
/// 末尾の文末記号 (`;`) は落とす — 戻り値はラッパー SELECT へそのまま連結
/// するため。ユーザが `WHERE` の後に書いた `ORDER BY` / `LIMIT` (MySQL の
/// UPDATE/DELETE で有効) はそのまま保持するので、BEFORE スナップショットも
/// 同じ絞り込みに従う。
///
/// PostgreSQL 方言では末尾の `RETURNING …` を切り落とす。`UPDATE … WHERE …
/// RETURNING *` の尾をそのまま `SELECT * FROM t <尾>` へ連結すると構文
/// エラーになり、プレビュー全体が失敗してしまうため (MySQL 方言では既存
/// 挙動をバイト単位で維持したいので何もしない)。
pub(crate) fn extract_where_and_after(sql: &str, flavor: SqlFlavor) -> Option<String> {
    let cleaned = super::strip_sql_comments(sql, flavor);
    let (pos, _) = find_top_level_keyword(&cleaned, &["where"], flavor)?;
    clause_tail(&cleaned, pos, flavor)
}

/// BEFORE スナップショットに使うユーザの WHERE 句 (無ければ `None`)。
///
/// 適用条件は 2 つ:
///
/// * **主キーが判っていること**。AFTER は BEFORE で捕まえた PK で取り直す
///   ([`build_after_by_pk_sql`]) ことで両ペインが行単位で揃う。PK が無い
///   場合のフォールバックは BEFORE と同じクエリを撮り直すだけなので、
///   WHERE で絞ると更新後に一致しなくなり (`… SET flag=0 WHERE flag=1` は
///   実行後に 0 件) 対応付けが壊れる。
/// * **UPDATE / DELETE であること**。INSERT は WHERE を持たないうえ、新規行は
///   BEFORE に居ないので固定窓のほうが見える。
///
/// PostgreSQL の `UPDATE … FROM other …` / `DELETE … USING other …` は、
/// WHERE が別テーブルを参照するため単独の `SELECT * FROM t <尾>` として
/// 成立しない。トップレベルに `FROM` / `USING` を見つけたら WHERE の再利用を
/// あきらめ、従来どおりの固定窓へ縮退する (誤った SQL でプレビュー自体を
/// 失敗させるより、取りこぼしのある窓のほうがまし)。
pub(crate) fn before_where_clause(
    sql: &str,
    flavor: SqlFlavor,
    primary_key: &[String],
) -> Option<String> {
    if primary_key.is_empty() {
        return None;
    }
    let head = sql.trim_start().to_ascii_lowercase();
    let is_postgres = flavor == SqlFlavor::Postgres;
    // 先頭に置く "where" が「見つけたい句」、それ以降は「これが先に出たら
    // WHERE の再利用をやめる」失格キーワード。
    let keywords: &[&str] = if head.starts_with("update") {
        if is_postgres {
            &["where", "from"]
        } else {
            &["where"]
        }
    } else if head.starts_with("delete") {
        if is_postgres {
            // DELETE 自身の `FROM` は正当なので見張らない。多テーブル削除の
            // 目印は `USING`。
            &["where", "using"]
        } else {
            &["where"]
        }
    } else {
        return None;
    };

    // 失格キーワードが無い方言 (= 探すのは `WHERE` だけ) では、抽出そのものは
    // [`extract_where_and_after`] と同一なのでそちらへ委譲する。
    if keywords.len() == 1 {
        return extract_where_and_after(sql, flavor);
    }

    let cleaned = super::strip_sql_comments(sql, flavor);
    let (pos, which) = find_top_level_keyword(&cleaned, keywords, flavor)?;
    if which != 0 {
        return None;
    }
    clause_tail(&cleaned, pos, flavor)
}

/// スナップショット用の `SELECT * FROM …` を組み立てる。
///
/// * `where_clause` — [`before_where_clause`] が返した句 (`WHERE …` を含む
///   完全な尾)。`None` ならテーブル全体が対象。
/// * `order_clause` — `db::pk_order_clause` の戻り値 (先頭に空白を含む
///   ` ORDER BY …`、PK が無ければ空文字)。
/// * `limit` — 付けるなら `Some(n)`。ユーザの句に彼ら自身の `LIMIT` が
///   含まれうる方言 (MySQL の UPDATE/DELETE) では衝突を避けるため `None` を
///   渡し、行数の上限は取得側 (`fetch_capped*`) で担保する。
pub(crate) fn build_snapshot_sql(
    target: &str,
    where_clause: Option<&str>,
    order_clause: &str,
    limit: Option<usize>,
) -> String {
    let mut sql = format!("SELECT * FROM {}", target);
    if let Some(w) = where_clause {
        sql.push(' ');
        sql.push_str(w);
    }
    sql.push_str(order_clause);
    if let Some(n) = limit {
        sql.push_str(&format!(" LIMIT {}", n));
    }
    sql
}

/// BEFORE で捕まえた主キーで AFTER を取り直す `SELECT` を組み立てる。
///
/// `rows` は 1 行ぶんの PK 値を表す **SQL 断片**の並び (行数 × PK 列数)。
/// 断片の作り方はドライバに委ねる — MySQL は `?` を並べて後から bind し、
/// PostgreSQL は型推論の都合でリテラルを埋め込む (詳細は各ドライバの
/// 呼び出し側コメント)。
///
/// 単一列 PK は `WHERE pk IN (a, b, …)`、複合 PK は行コンストラクタ
/// `WHERE (a,b) IN ((…,…), (…,…))` を使う (MySQL / PostgreSQL とも
/// ネイティブに解釈できるので OR チェインへ落とす必要はない)。
///
/// 断片の数が PK 列数と合わない・PK や行が空の場合は `None` を返し、
/// 呼び出し側は AFTER をアンカー無しのフォールバックへ落とす。
pub(crate) fn build_after_by_pk_sql(
    target: &str,
    pk_cols: &[String],
    rows: &[Vec<String>],
    order_clause: &str,
    quote: fn(&str) -> String,
) -> Option<String> {
    if pk_cols.is_empty() || rows.is_empty() {
        return None;
    }
    if rows.iter().any(|r| r.len() != pk_cols.len()) {
        return None;
    }
    let idents: Vec<String> = pk_cols.iter().map(|c| quote(c)).collect();
    let joined = idents.join(",");
    let lhs = if idents.len() == 1 {
        joined
    } else {
        format!("({})", joined)
    };
    let tuples: Vec<String> = rows
        .iter()
        .map(|r| {
            let inner = r.join(",");
            if r.len() == 1 {
                inner
            } else {
                format!("({})", inner)
            }
        })
        .collect();
    Some(format!(
        "SELECT * FROM {} WHERE {} IN ({}){}",
        target,
        lhs,
        tuples.join(","),
        order_clause
    ))
}

/// `cleaned[pos..]` を句として整える: 前後の空白を落とし、PostgreSQL では
/// トップレベルの `RETURNING …` を切り、末尾の `;` を落とす。空になったら
/// `None`。
fn clause_tail(cleaned: &str, pos: usize, flavor: SqlFlavor) -> Option<String> {
    let mut tail = cleaned.get(pos..)?;
    if flavor == SqlFlavor::Postgres {
        if let Some((ret, _)) = find_top_level_keyword(tail, &["returning"], flavor) {
            tail = tail.get(..ret)?;
        }
    }
    let mut tail = tail.trim();
    if let Some(stripped) = tail.strip_suffix(';') {
        tail = stripped.trim_end();
    }
    if tail.is_empty() {
        None
    } else {
        Some(tail.to_string())
    }
}

/// `cleaned` (コメント除去済み) の**トップレベル**に最初に現れる
/// `keywords` のいずれかを探し、`(バイト位置, keywords 内の添字)` を返す。
///
/// 文字列リテラル・引用付き識別子・括弧の深さ・PostgreSQL のドル引用を
/// 追跡するので、サブクエリや文字列の中のキーワードは拾わない。前後が識別子
/// 文字でないこと (`whereabouts` を `where` と読まない) も確認する。
fn find_top_level_keyword(
    cleaned: &str,
    keywords: &[&str],
    flavor: SqlFlavor,
) -> Option<(usize, usize)> {
    let bytes = cleaned.as_bytes();
    let n = bytes.len();
    // バックスラッシュを文字列のエスケープと見なすのは MySQL だけ (#852 と
    // 同じ方針)。ドル引用は PostgreSQL だけ、バックティック識別子は
    // PostgreSQL 以外。
    let backslash_escapes = flavor == SqlFlavor::MySql;
    let dollar_quotes = flavor == SqlFlavor::Postgres;
    let backtick_quotes = flavor != SqlFlavor::Postgres;
    let mut depth: i32 = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut i: usize = 0;
    while i < n {
        let c = bytes[i];
        if in_single {
            if backslash_escapes && c == b'\\' && i + 1 < n {
                i += 2;
                continue;
            }
            if c == b'\'' {
                // Doubled '' inside '...' is an escaped quote, not the end.
                if i + 1 < n && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                in_single = false;
            }
        } else if in_double {
            if backslash_escapes && c == b'\\' && i + 1 < n {
                i += 2;
                continue;
            }
            if c == b'"' {
                if i + 1 < n && bytes[i + 1] == b'"' {
                    i += 2;
                    continue;
                }
                in_double = false;
            }
        } else if in_backtick {
            if c == b'`' {
                in_backtick = false;
            }
        } else {
            match c {
                b'\'' => in_single = true,
                b'"' => in_double = true,
                b'`' if backtick_quotes => in_backtick = true,
                b'(' => depth += 1,
                b')' if depth > 0 => {
                    depth -= 1;
                }
                b'$' if dollar_quotes && (i == 0 || !is_ident_byte(bytes[i - 1])) => {
                    // `$tag$ … $tag$` は中身を丸ごと読み飛ばす。閉じタグが
                    // 無ければただの `$` として扱う。
                    if let Some(end) = skip_dollar_quoted(bytes, i) {
                        i = end;
                        continue;
                    }
                }
                _ if depth == 0 => {
                    if let Some(k) = keyword_at(bytes, i, keywords) {
                        return Some((i, k));
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// `bytes[i..]` がいずれかのキーワードと (識別子境界つきで) 一致すれば、
/// その `keywords` 内の添字を返す。
fn keyword_at(bytes: &[u8], i: usize, keywords: &[&str]) -> Option<usize> {
    let n = bytes.len();
    for (k, kw) in keywords.iter().enumerate() {
        let len = kw.len();
        if i + len > n {
            continue;
        }
        let Some(slice) = bytes.get(i..i + len) else {
            continue;
        };
        if !slice.eq_ignore_ascii_case(kw.as_bytes()) {
            continue;
        }
        let left_ok = i == 0 || !bytes.get(i - 1).copied().is_some_and(is_ident_byte);
        let right_ok = i + len == n || !bytes.get(i + len).copied().is_some_and(is_ident_byte);
        if left_ok && right_ok {
            return Some(k);
        }
    }
    None
}

/// `bytes[start]` がドル引用の開始 (`$` / `$tag$`) なら、閉じタグの**直後**の
/// 位置を返す。タグとして成立しない、または閉じられていない場合は `None`。
fn skip_dollar_quoted(bytes: &[u8], start: usize) -> Option<usize> {
    let n = bytes.len();
    let mut j = start + 1;
    // タグ本体に使えるのは英数字と `_` のみ。`is_ident_byte` は `$` も
    // 含むため、ここで使うと `$$` の閉じ `$` まで飲み込んでしまう。
    while j < n && bytes.get(j).copied().is_some_and(is_dollar_tag_byte) {
        j += 1;
    }
    if j >= n || bytes.get(j).copied() != Some(b'$') {
        return None;
    }
    let tag = bytes.get(start..=j)?;
    let mut p = j + 1;
    while p + tag.len() <= n {
        if bytes.get(p..p + tag.len()) == Some(tag) {
            return Some(p + tag.len());
        }
        p += 1;
    }
    None
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn is_dollar_tag_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MySQL 由来のケース群 (元は `db::mysql` の単体テスト)。共有化しても
    /// MySQL 方言の解釈が変わっていないことを固定する。
    fn mysql_where(sql: &str) -> Option<String> {
        extract_where_and_after(sql, SqlFlavor::MySql)
    }

    #[test]
    fn extracts_outer_where_from_update() {
        assert_eq!(
            mysql_where("UPDATE users SET name = 'a' WHERE id = 1"),
            Some("WHERE id = 1".into())
        );
    }

    #[test]
    fn extracts_outer_where_from_delete() {
        assert_eq!(
            mysql_where("DELETE FROM orders WHERE total > 100"),
            Some("WHERE total > 100".into())
        );
    }

    #[test]
    fn extract_where_returns_none_when_absent() {
        assert!(mysql_where("UPDATE t SET x = 1").is_none());
        assert!(mysql_where("DELETE FROM t").is_none());
    }

    #[test]
    fn extract_where_ignores_inner_where_in_subquery() {
        // The WHERE inside the SET subquery is at paren depth > 0 and must
        // be skipped — otherwise we'd build the BEFORE snapshot from the
        // subquery's filter instead of the outer one.
        assert_eq!(
            mysql_where("UPDATE t SET x = (SELECT y FROM s WHERE z = 1) WHERE id = 5"),
            Some("WHERE id = 5".into())
        );
        assert!(mysql_where("UPDATE t SET x = (SELECT y FROM s WHERE z = 1)").is_none());
    }

    #[test]
    fn extract_where_ignores_keyword_in_string_literal() {
        // 'WHERE' inside a single-quoted literal must not be picked up as
        // the outer keyword.
        assert_eq!(
            mysql_where("UPDATE t SET x = 'WHERE' WHERE id = 1"),
            Some("WHERE id = 1".into())
        );
        // Doubled-quote escape '' inside the string must not prematurely
        // close it.
        assert_eq!(
            mysql_where("UPDATE t SET x = 'a''b WHERE c' WHERE id = 1"),
            Some("WHERE id = 1".into())
        );
    }

    #[test]
    fn extract_where_ignores_keyword_in_backtick_identifier() {
        // A column literally named `where` must not be picked up as the
        // keyword. We then expect the real keyword that follows.
        assert_eq!(
            mysql_where("UPDATE t SET `where` = 1 WHERE id = 2"),
            Some("WHERE id = 2".into())
        );
    }

    #[test]
    fn extract_where_preserves_trailing_clauses() {
        // ORDER BY / LIMIT after WHERE belong to the user's mutation and
        // should be reused verbatim by the BEFORE-snapshot SELECT.
        assert_eq!(
            mysql_where("DELETE FROM t WHERE y = 2 ORDER BY id DESC LIMIT 10"),
            Some("WHERE y = 2 ORDER BY id DESC LIMIT 10".into())
        );
    }

    #[test]
    fn extract_where_strips_trailing_semicolon() {
        // A trailing `;` would break the wrapper SELECT it gets spliced
        // into, so the extractor drops it.
        assert_eq!(
            mysql_where("UPDATE t SET x=1 WHERE id=1;"),
            Some("WHERE id=1".into())
        );
    }

    #[test]
    fn extract_where_ignores_identifier_prefixed_with_where() {
        // `whereabouts` starts with "where" but is not the keyword.
        assert!(mysql_where("UPDATE t SET whereabouts = 'home'").is_none());
    }

    #[test]
    fn mysql_backslash_escape_hides_quote() {
        // MySQL では `\'` は文字列の中のエスケープなので、リテラルはまだ
        // 閉じておらず、その中の WHERE は拾わない。
        assert!(mysql_where(r"UPDATE t SET x = 'a\' WHERE b'").is_none());
    }

    #[test]
    fn postgres_backslash_is_not_an_escape() {
        // standard_conforming_strings = on の PostgreSQL では `\` はただの
        // 文字なので、直後の `'` でリテラルが閉じ、その後の WHERE が見える。
        assert_eq!(
            extract_where_and_after(r"UPDATE t SET x = 'a\' WHERE b = 1", SqlFlavor::Postgres),
            Some("WHERE b = 1".into())
        );
    }

    #[test]
    fn postgres_dollar_quoted_body_is_skipped() {
        // ドル引用の中の WHERE を外側の句と取り違えない。
        assert_eq!(
            extract_where_and_after(
                "UPDATE t SET x = $$ where inside $$ WHERE id = 7",
                SqlFlavor::Postgres
            ),
            Some("WHERE id = 7".into())
        );
        assert_eq!(
            extract_where_and_after(
                "UPDATE t SET x = $tag$ where $tag$ WHERE id = 7",
                SqlFlavor::Postgres
            ),
            Some("WHERE id = 7".into())
        );
    }

    #[test]
    fn postgres_returning_is_cut_from_the_clause() {
        // `SELECT * FROM t WHERE … RETURNING *` は構文エラーになるので、
        // 尾から RETURNING 以降を落とす。
        assert_eq!(
            extract_where_and_after(
                "UPDATE t SET x = 1 WHERE id = 3 RETURNING *",
                SqlFlavor::Postgres
            ),
            Some("WHERE id = 3".into())
        );
        // 文字列の中の `returning` は切らない。
        assert_eq!(
            extract_where_and_after(
                "DELETE FROM t WHERE note = 'returning soon'",
                SqlFlavor::Postgres
            ),
            Some("WHERE note = 'returning soon'".into())
        );
    }

    #[test]
    fn before_where_requires_pk_and_mutation_kind() {
        let pk = vec!["id".to_string()];
        assert_eq!(
            before_where_clause("UPDATE t SET x = 1 WHERE id = 1", SqlFlavor::MySql, &pk),
            Some("WHERE id = 1".into())
        );
        // PK が判らないときは WHERE を使わない (AFTER の対応付けが壊れるため)。
        assert!(
            before_where_clause("UPDATE t SET x = 1 WHERE id = 1", SqlFlavor::MySql, &[]).is_none()
        );
        // INSERT は対象外。
        assert!(
            before_where_clause("INSERT INTO t (id) VALUES (1)", SqlFlavor::MySql, &pk).is_none()
        );
    }

    #[test]
    fn before_where_skips_postgres_joined_mutations() {
        let pk = vec!["id".to_string()];
        // UPDATE … FROM other … の WHERE は other を参照するので再利用不可。
        assert!(before_where_clause(
            "UPDATE t SET x = o.x FROM o WHERE t.id = o.id",
            SqlFlavor::Postgres,
            &pk
        )
        .is_none());
        // DELETE … USING other … も同じ。
        assert!(before_where_clause(
            "DELETE FROM t USING o WHERE t.id = o.id",
            SqlFlavor::Postgres,
            &pk
        )
        .is_none());
        // DELETE 自身の FROM は失格キーワードではない。
        assert_eq!(
            before_where_clause("DELETE FROM t WHERE id = 1", SqlFlavor::Postgres, &pk),
            Some("WHERE id = 1".into())
        );
        // サブクエリの中の FROM も (深さ > 0 なので) 失格にしない。
        assert_eq!(
            before_where_clause(
                "UPDATE t SET x = (SELECT y FROM s LIMIT 1) WHERE id = 1",
                SqlFlavor::Postgres,
                &pk
            ),
            Some("WHERE id = 1".into())
        );
    }

    #[test]
    fn builds_snapshot_sql_variants() {
        // フィルタ無し + PK 順 + LIMIT (従来の固定窓)。
        assert_eq!(
            build_snapshot_sql("t", None, " ORDER BY `id`", Some(101)),
            "SELECT * FROM t ORDER BY `id` LIMIT 101"
        );
        // ユーザの WHERE をそのまま連結 (MySQL は LIMIT を足さない)。
        assert_eq!(
            build_snapshot_sql("`db`.`t`", Some("WHERE id = 1"), "", None),
            "SELECT * FROM `db`.`t` WHERE id = 1"
        );
        // PostgreSQL は WHERE と ORDER BY / LIMIT を併用できる。
        assert_eq!(
            build_snapshot_sql(
                "public.t",
                Some("WHERE id = 1"),
                " ORDER BY \"id\"",
                Some(11)
            ),
            "SELECT * FROM public.t WHERE id = 1 ORDER BY \"id\" LIMIT 11"
        );
    }

    #[test]
    fn builds_after_by_pk_for_single_and_composite_keys() {
        let quote: fn(&str) -> String = |s| format!("`{}`", s.replace('`', "``"));
        let single = vec!["id".to_string()];
        assert_eq!(
            build_after_by_pk_sql(
                "t",
                &single,
                &[vec!["?".into()], vec!["?".into()]],
                " ORDER BY `id`",
                quote
            ),
            Some("SELECT * FROM t WHERE `id` IN (?,?) ORDER BY `id`".to_string())
        );
        let composite = vec!["a".to_string(), "b".to_string()];
        assert_eq!(
            build_after_by_pk_sql("t", &composite, &[vec!["?".into(), "?".into()]], "", quote),
            Some("SELECT * FROM t WHERE (`a`,`b`) IN ((?,?))".to_string())
        );
        // リテラル埋め込み (PostgreSQL 経路) も同じ組み立てを共有する。
        let pg_quote: fn(&str) -> String = |s| format!("\"{}\"", s.replace('"', "\"\""));
        assert_eq!(
            build_after_by_pk_sql(
                "public.t",
                &single,
                &[vec!["'42'".into()]],
                " ORDER BY \"id\"",
                pg_quote
            ),
            Some("SELECT * FROM public.t WHERE \"id\" IN ('42') ORDER BY \"id\"".to_string())
        );
    }

    #[test]
    fn after_by_pk_rejects_degenerate_inputs() {
        let quote: fn(&str) -> String = |s| s.to_string();
        let pk = vec!["id".to_string()];
        assert!(build_after_by_pk_sql("t", &[], &[vec!["?".into()]], "", quote).is_none());
        assert!(build_after_by_pk_sql("t", &pk, &[], "", quote).is_none());
        // 断片の数が PK 列数と合わない行があれば組み立てない (壊れた IN 句を
        // 投げるより AFTER をフォールバックさせる)。
        assert!(
            build_after_by_pk_sql("t", &pk, &[vec!["?".into(), "?".into()]], "", quote).is_none()
        );
    }
}
