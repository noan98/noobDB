//! パーティション表の子パーティション一覧 (#1868) の純層。PostgreSQL の
//! `pg_get_partkeydef` の分解と、MySQL の `information_schema.PARTITIONS` の行
//! (パーティション × サブパーティションの平坦な行) を親子の入れ子に畳む処理。DB 無しでテストできる。

use super::types::{TablePartition, TablePartitions};

/// `pg_get_partkeydef` の戻り値 (`RANGE (created_at)` / `LIST (lower(region))` など) を
/// (方式, キー式) に分ける。括弧が読めなければ全体を方式として返す。
pub fn split_pg_partkeydef(def: &str) -> (String, String) {
    let def = def.trim();
    match def.find('(') {
        Some(i) if def.ends_with(')') => (
            def[..i].trim().to_ascii_uppercase(),
            def[i + 1..def.len() - 1].trim().to_string(),
        ),
        _ => (def.to_ascii_uppercase(), String::new()),
    }
}

/// PostgreSQL の中間パーティション (`is_partitioned`) は自身にデータを持たないので、サイズと行数が
/// 0 になってしまう。深さ優先に並んだ一覧で、各中間パーティションに子孫の葉の合計を足し込む。
/// 葉だけを数えるので、入れ子が深くても二重計上しない。子孫の値が全て `None` なら `None` のまま。
pub fn roll_up_partition_totals(parts: &mut [TablePartition]) {
    for i in 0..parts.len() {
        if !parts[i].is_partitioned {
            continue;
        }
        let depth = parts[i].depth;
        let mut size: Option<i64> = None;
        let mut rows: Option<i64> = None;
        for d in parts[i + 1..].iter().take_while(|d| d.depth > depth) {
            if d.is_partitioned {
                continue;
            }
            size = add(size, d.size_bytes);
            rows = add(rows, d.row_estimate);
        }
        parts[i].size_bytes =
            add(size, parts[i].size_bytes.filter(|n| *n > 0)).or(parts[i].size_bytes);
        parts[i].row_estimate =
            add(rows, parts[i].row_estimate.filter(|n| *n > 0)).or(parts[i].row_estimate);
    }
}

/// `information_schema.PARTITIONS` の 1 行 (パーティション名が NULL の行 = 非分割表は呼び出し側で除く)。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MysqlPartitionRow {
    pub partition_name: String,
    pub subpartition_name: Option<String>,
    pub method: String,
    pub sub_method: Option<String>,
    pub expression: Option<String>,
    pub sub_expression: Option<String>,
    pub description: Option<String>,
    pub rows: Option<i64>,
    pub data_bytes: Option<i64>,
    pub index_bytes: Option<i64>,
}

fn add(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (None, None) => None,
        (x, y) => Some(x.unwrap_or(0).saturating_add(y.unwrap_or(0))),
    }
}

/// MySQL の PARTITIONS 行 (パーティション順・サブパーティション順に並んでいる前提) を
/// [`TablePartitions`] にする。サブパーティションがあるパーティションは、親の行 (サイズ・行数は
/// 子の合計、`is_partitioned = true`) の直後に子 (`depth = 1`) を並べる。行が無ければ `None`。
pub fn fold_mysql_partitions(rows: &[MysqlPartitionRow]) -> Option<TablePartitions> {
    let first = rows.first()?;
    let mut out = TablePartitions {
        method: first.method.to_ascii_uppercase(),
        key: first.expression.clone().unwrap_or_default(),
        sub_method: first.sub_method.as_ref().map(|m| m.to_ascii_uppercase()),
        sub_key: first.sub_expression.clone(),
        partitions: Vec::new(),
    };
    for r in rows {
        let size = add(r.data_bytes, r.index_bytes);
        match &r.subpartition_name {
            None => out.partitions.push(TablePartition {
                name: r.partition_name.clone(),
                schema: None,
                parent: None,
                parent_schema: None,
                depth: 0,
                bound: mysql_bound(&r.method, r.description.as_deref()),
                size_bytes: size,
                row_estimate: r.rows,
                is_default: false,
                is_partitioned: false,
                sub_partition_key: None,
            }),
            Some(sub) => {
                // 親の行はそのパーティションの最初のサブパーティションで 1 度だけ作る。
                let need_parent = !out
                    .partitions
                    .iter()
                    .rev()
                    .find(|p| p.depth == 0)
                    .is_some_and(|p| p.name == r.partition_name);
                if need_parent {
                    out.partitions.push(TablePartition {
                        name: r.partition_name.clone(),
                        schema: None,
                        parent: None,
                        parent_schema: None,
                        depth: 0,
                        bound: mysql_bound(&r.method, r.description.as_deref()),
                        size_bytes: None,
                        row_estimate: None,
                        is_default: false,
                        is_partitioned: true,
                        sub_partition_key: r.sub_expression.clone(),
                    });
                }
                // 親の合計は直前の親の行へ足し込む (子を push する前に探す)。
                if let Some(parent) = out
                    .partitions
                    .iter_mut()
                    .rev()
                    .find(|p| p.depth == 0 && p.name == r.partition_name)
                {
                    parent.size_bytes = add(parent.size_bytes, size);
                    parent.row_estimate = add(parent.row_estimate, r.rows);
                }
                out.partitions.push(TablePartition {
                    name: sub.clone(),
                    schema: None,
                    parent: Some(r.partition_name.clone()),
                    parent_schema: None,
                    depth: 1,
                    bound: String::new(),
                    size_bytes: size,
                    row_estimate: r.rows,
                    is_default: false,
                    is_partitioned: false,
                    sub_partition_key: None,
                });
            }
        }
    }
    Some(out)
}

/// 境界の表示用の文字列。RANGE 系は `LESS THAN (...)`、LIST 系は `IN (...)`、HASH / KEY は境界なし。
fn mysql_bound(method: &str, description: Option<&str>) -> String {
    let Some(d) = description.map(str::trim).filter(|d| !d.is_empty()) else {
        return String::new();
    };
    let m = method.to_ascii_uppercase();
    if m.starts_with("RANGE") {
        // MAXVALUE は括弧なしで `LESS THAN MAXVALUE`。
        if d.eq_ignore_ascii_case("MAXVALUE") {
            "LESS THAN MAXVALUE".to_string()
        } else {
            format!("LESS THAN ({d})")
        }
    } else if m.starts_with("LIST") {
        format!("IN ({d})")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(p: &str, sub: Option<&str>, rows: i64, data: i64) -> MysqlPartitionRow {
        MysqlPartitionRow {
            partition_name: p.into(),
            subpartition_name: sub.map(Into::into),
            method: "RANGE".into(),
            sub_method: sub.map(|_| "HASH".into()),
            expression: Some("`created`".into()),
            sub_expression: sub.map(|_| "`id`".into()),
            description: Some("100".into()),
            rows: Some(rows),
            data_bytes: Some(data),
            index_bytes: Some(10),
        }
    }

    #[test]
    fn partkeydef_is_split() {
        assert_eq!(
            split_pg_partkeydef("RANGE (created_at)"),
            ("RANGE".into(), "created_at".into())
        );
        assert_eq!(
            split_pg_partkeydef("LIST (lower(region))"),
            ("LIST".into(), "lower(region)".into())
        );
        assert_eq!(
            split_pg_partkeydef("HASH (a, b)"),
            ("HASH".into(), "a, b".into())
        );
        assert_eq!(
            split_pg_partkeydef("weird"),
            ("WEIRD".into(), String::new())
        );
    }

    #[test]
    fn mysql_flat_partitions() {
        let mut maxv = row("pmax", None, 0, 0);
        maxv.description = Some("MAXVALUE".into());
        let t = fold_mysql_partitions(&[row("p0", None, 5, 100), maxv]).unwrap();
        assert_eq!(t.method, "RANGE");
        assert_eq!(t.key, "`created`");
        assert_eq!(t.partitions.len(), 2);
        assert_eq!(t.partitions[0].bound, "LESS THAN (100)");
        assert_eq!(t.partitions[0].size_bytes, Some(110));
        assert_eq!(t.partitions[1].bound, "LESS THAN MAXVALUE");
        assert!(!t.partitions[0].is_partitioned);
    }

    #[test]
    fn mysql_subpartitions_nest_under_parent() {
        let t = fold_mysql_partitions(&[
            row("p0", Some("p0sp0"), 3, 100),
            row("p0", Some("p0sp1"), 4, 200),
            row("p1", Some("p1sp0"), 1, 50),
        ])
        .unwrap();
        assert_eq!(t.sub_method.as_deref(), Some("HASH"));
        let names: Vec<_> = t
            .partitions
            .iter()
            .map(|p| (p.name.as_str(), p.depth))
            .collect();
        assert_eq!(
            names,
            vec![
                ("p0", 0),
                ("p0sp0", 1),
                ("p0sp1", 1),
                ("p1", 0),
                ("p1sp0", 1)
            ]
        );
        // 親は子の合計 (サイズは data + index)。
        assert_eq!(t.partitions[0].row_estimate, Some(7));
        assert_eq!(t.partitions[0].size_bytes, Some(320));
        assert!(t.partitions[0].is_partitioned);
        assert_eq!(t.partitions[1].parent.as_deref(), Some("p0"));
    }

    #[test]
    fn mysql_list_and_hash_bounds() {
        let mut l = row("pa", None, 0, 0);
        l.method = "LIST".into();
        l.description = Some("1,2,3".into());
        assert_eq!(
            fold_mysql_partitions(&[l]).unwrap().partitions[0].bound,
            "IN (1,2,3)"
        );
        let mut h = row("p0", None, 0, 0);
        h.method = "HASH".into();
        h.description = None;
        assert_eq!(fold_mysql_partitions(&[h]).unwrap().partitions[0].bound, "");
    }

    fn pg(
        name: &str,
        depth: u32,
        partitioned: bool,
        size: Option<i64>,
        rows: Option<i64>,
    ) -> TablePartition {
        TablePartition {
            name: name.into(),
            schema: Some("public".into()),
            parent: None,
            parent_schema: None,
            depth,
            bound: String::new(),
            size_bytes: size,
            row_estimate: rows,
            is_default: false,
            is_partitioned: partitioned,
            sub_partition_key: None,
        }
    }

    #[test]
    fn roll_up_sums_leaves_into_intermediate_partitions() {
        let mut v = vec![
            pg("a", 0, true, Some(0), None),
            pg("a1", 1, false, Some(100), Some(5)),
            pg("a2", 1, true, Some(0), Some(-0)),
            pg("a2x", 2, false, Some(50), Some(2)),
            pg("b", 0, false, Some(7), Some(1)),
        ];
        roll_up_partition_totals(&mut v);
        assert_eq!((v[0].size_bytes, v[0].row_estimate), (Some(150), Some(7)));
        assert_eq!((v[2].size_bytes, v[2].row_estimate), (Some(50), Some(2)));
        // 葉と無関係な行は変わらない。
        assert_eq!((v[4].size_bytes, v[4].row_estimate), (Some(7), Some(1)));
    }

    #[test]
    fn roll_up_keeps_none_when_no_leaf_has_values() {
        let mut v = vec![pg("a", 0, true, None, None), pg("a1", 1, false, None, None)];
        roll_up_partition_totals(&mut v);
        assert_eq!((v[0].size_bytes, v[0].row_estimate), (None, None));
    }

    #[test]
    fn empty_rows_is_none() {
        assert!(fold_mysql_partitions(&[]).is_none());
    }
}
