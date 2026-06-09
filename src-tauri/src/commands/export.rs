use std::io::Write;

use serde::Deserialize;

use crate::db::types::{Column, Value};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Ndjson,
}

#[tauri::command]
pub async fn export_query_result(
    path: String,
    format: ExportFormat,
    columns: Vec<Column>,
    rows: Vec<Vec<Value>>,
) -> Result<u64> {
    if path.trim().is_empty() {
        return Err(AppError::InvalidInput("save path is empty".into()));
    }
    let row_count = rows.len();
    let result = write_export(path, format, columns, rows).await;
    match &result {
        Ok(bytes) => tracing::info!(
            format = ?format,
            rows = row_count,
            bytes = *bytes,
            "query result exported"
        ),
        Err(e) => tracing::error!(format = ?format, error = %e, "failed to export query result"),
    }
    result
}

/// Write the result set to `path`, streaming row-by-row into a buffered writer
/// instead of building the whole output in memory first. The CPU-bound
/// formatting and synchronous file I/O run on a blocking thread so the async
/// runtime worker is not held up by a large export. Returns the bytes written.
async fn write_export(
    path: String,
    format: ExportFormat,
    columns: Vec<Column>,
    rows: Vec<Vec<Value>>,
) -> Result<u64> {
    tokio::task::spawn_blocking(move || -> Result<u64> {
        let file = std::fs::File::create(&path)?;
        let mut writer = std::io::BufWriter::new(file);
        match format {
            ExportFormat::Csv => write_csv(&mut writer, &columns, &rows)?,
            ExportFormat::Json => write_json(&mut writer, &columns, &rows)?,
            ExportFormat::Ndjson => write_ndjson(&mut writer, &columns, &rows)?,
        }
        // `into_inner` flushes the buffer; surface any flush error as I/O.
        let file = writer
            .into_inner()
            .map_err(|e| AppError::Io(e.into_error()))?;
        let bytes = file.metadata()?.len();
        Ok(bytes)
    })
    .await
    .map_err(|e| AppError::Other(format!("export task failed: {e}")))?
}

fn csv_field(s: &str) -> String {
    let needs_quote = s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r');
    if !needs_quote {
        return s.to_string();
    }
    let escaped = s.replace('"', "\"\"");
    format!("\"{}\"", escaped)
}

fn value_to_csv(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::String(s) => csv_field(s),
        Value::Bytes(hex) => csv_field(&format!("0x{}", hex)),
    }
}

/// RFC4180-ish CSV with `\r\n` terminators, written one row at a time. A single
/// reused line buffer keeps allocations and `write` syscalls down (one write per
/// row); the `BufWriter` from the caller batches them further.
fn write_csv<W: Write>(w: &mut W, columns: &[Column], rows: &[Vec<Value>]) -> std::io::Result<()> {
    let mut line = String::new();
    for (i, col) in columns.iter().enumerate() {
        if i > 0 {
            line.push(',');
        }
        line.push_str(&csv_field(&col.name));
    }
    line.push_str("\r\n");
    w.write_all(line.as_bytes())?;

    for row in rows {
        line.clear();
        for i in 0..columns.len() {
            if i > 0 {
                line.push(',');
            }
            line.push_str(&value_to_csv(row.get(i).unwrap_or(&Value::Null)));
        }
        line.push_str("\r\n");
        w.write_all(line.as_bytes())?;
    }
    Ok(())
}

/// Pretty JSON array of row objects, serialized directly to the writer. Each row
/// object is built and serialized individually via `SerializeSeq`, so the full
/// `Vec`-of-objects tree is never materialized. The output is byte-identical to
/// `serde_json::to_vec_pretty` of the equivalent array (serde drives a `Vec`
/// through the same `serialize_seq`/`serialize_element` path).
fn write_json<W: Write>(w: &mut W, columns: &[Column], rows: &[Vec<Value>]) -> Result<()> {
    use serde::ser::{SerializeSeq, Serializer};
    use serde_json::{Map, Value as J};

    let mut ser = serde_json::Serializer::pretty(w);
    let mut seq = ser.serialize_seq(Some(rows.len()))?;
    for row in rows {
        let mut obj = Map::with_capacity(columns.len());
        for (i, col) in columns.iter().enumerate() {
            let jv = match row.get(i).unwrap_or(&Value::Null) {
                Value::Bytes(hex) => J::String(format!("0x{}", hex)),
                v => serde_json::to_value(v).unwrap_or(J::Null),
            };
            obj.insert(col.name.clone(), jv);
        }
        seq.serialize_element(&J::Object(obj))?;
    }
    seq.end()?;
    Ok(())
}

fn row_to_json_object(columns: &[Column], row: &[Value]) -> serde_json::Value {
    use serde_json::{Map, Value as J};
    let mut obj = Map::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let jv = match row.get(i).unwrap_or(&Value::Null) {
            Value::Bytes(hex) => J::String(format!("0x{}", hex)),
            v => serde_json::to_value(v).unwrap_or(J::Null),
        };
        obj.insert(col.name.clone(), jv);
    }
    J::Object(obj)
}

/// NDJSON (newline-delimited JSON): one compact JSON object per line, no
/// surrounding brackets or separators. Empty result produces an empty file.
/// Value encoding (BLOB as `0x...`, NULL, numbers) matches the JSON exporter.
fn write_ndjson<W: Write>(w: &mut W, columns: &[Column], rows: &[Vec<Value>]) -> Result<()> {
    for row in rows {
        let obj = row_to_json_object(columns, row);
        let line = serde_json::to_string(&obj)?;
        w.write_all(line.as_bytes())?;
        w.write_all(b"\n")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str) -> Column {
        Column {
            name: name.into(),
            type_name: "VARCHAR".into(),
        }
    }

    fn csv_bytes(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_csv(&mut buf, columns, rows).unwrap();
        buf
    }

    fn json_bytes(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_json(&mut buf, columns, rows).unwrap();
        buf
    }

    fn ndjson_bytes(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
        let mut buf = Vec::new();
        write_ndjson(&mut buf, columns, rows).unwrap();
        buf
    }

    #[test]
    fn csv_escapes_special_chars() {
        let columns = vec![col("id"), col("name"), col("note")];
        let rows = vec![
            vec![
                Value::Int(1),
                Value::String("Alice".into()),
                Value::String("ok".into()),
            ],
            vec![
                Value::Int(2),
                Value::String("Bob, the \"Builder\"".into()),
                Value::String("multi\nline".into()),
            ],
            vec![Value::Int(3), Value::Null, Value::Bool(true)],
        ];
        let out = String::from_utf8(csv_bytes(&columns, &rows)).unwrap();
        let expected = "id,name,note\r\n\
                        1,Alice,ok\r\n\
                        2,\"Bob, the \"\"Builder\"\"\",\"multi\nline\"\r\n\
                        3,,true\r\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn json_uses_column_names_and_handles_bytes() {
        let columns = vec![col("id"), col("blob")];
        let rows = vec![
            vec![Value::Int(7), Value::Bytes("deadbeef".into())],
            vec![Value::Null, Value::Null],
        ];
        let out = json_bytes(&columns, &rows);
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed[0]["id"], serde_json::json!(7));
        assert_eq!(parsed[0]["blob"], serde_json::json!("0xdeadbeef"));
        assert_eq!(parsed[1]["id"], serde_json::Value::Null);
        assert_eq!(parsed[1]["blob"], serde_json::Value::Null);
    }

    // Streaming serialization must stay byte-identical to the previous
    // "build the whole array then to_vec_pretty" approach (#274).
    #[test]
    fn json_matches_to_vec_pretty() {
        use serde_json::{Map, Value as J};
        let columns = vec![col("id"), col("name"), col("blob")];
        let rows = vec![
            vec![
                Value::Int(1),
                Value::String("Alice".into()),
                Value::Bytes("00ff".into()),
            ],
            vec![Value::Null, Value::String("x\"y".into()), Value::Null],
        ];

        // Reference: the old in-memory construction.
        let mut arr: Vec<J> = Vec::with_capacity(rows.len());
        for row in &rows {
            let mut obj = Map::with_capacity(columns.len());
            for (i, c) in columns.iter().enumerate() {
                let v = row.get(i).cloned().unwrap_or(Value::Null);
                let jv = match v {
                    Value::Bytes(ref hex) => J::String(format!("0x{}", hex)),
                    _ => serde_json::to_value(&v).unwrap_or(J::Null),
                };
                obj.insert(c.name.clone(), jv);
            }
            arr.push(J::Object(obj));
        }
        let reference = serde_json::to_vec_pretty(&arr).unwrap();

        assert_eq!(json_bytes(&columns, &rows), reference);
    }

    #[test]
    fn json_empty_rows_is_empty_array() {
        let columns = vec![col("id")];
        let rows: Vec<Vec<Value>> = vec![];
        let reference = serde_json::to_vec_pretty(&Vec::<serde_json::Value>::new()).unwrap();
        assert_eq!(json_bytes(&columns, &rows), reference);
    }

    #[test]
    fn ndjson_one_object_per_line() {
        let columns = vec![col("id"), col("name"), col("blob")];
        let rows = vec![
            vec![
                Value::Int(1),
                Value::String("Alice".into()),
                Value::Bytes("deadbeef".into()),
            ],
            vec![Value::Int(2), Value::Null, Value::Null],
        ];
        let out = String::from_utf8(ndjson_bytes(&columns, &rows)).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2);
        let row0: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(row0["id"], serde_json::json!(1));
        assert_eq!(row0["name"], serde_json::json!("Alice"));
        assert_eq!(row0["blob"], serde_json::json!("0xdeadbeef"));
        let row1: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(row1["id"], serde_json::json!(2));
        assert_eq!(row1["name"], serde_json::Value::Null);
    }

    #[test]
    fn ndjson_empty_rows_is_empty_file() {
        let columns = vec![col("id")];
        let rows: Vec<Vec<Value>> = vec![];
        assert_eq!(ndjson_bytes(&columns, &rows), b"");
    }

    #[test]
    fn ndjson_value_encoding_matches_json() {
        let columns = vec![col("n"), col("u"), col("f"), col("b"), col("s"), col("x")];
        let rows = vec![vec![
            Value::Int(-99),
            Value::UInt(42),
            Value::Float(3.14),
            Value::Bool(true),
            Value::String("hello".into()),
            Value::Bytes("ff00".into()),
        ]];
        let ndjson_out = String::from_utf8(ndjson_bytes(&columns, &rows)).unwrap();
        let ndjson_obj: serde_json::Value = serde_json::from_str(ndjson_out.trim()).unwrap();
        let json_out = json_bytes(&columns, &rows);
        let json_arr: serde_json::Value = serde_json::from_slice(&json_out).unwrap();
        assert_eq!(ndjson_obj, json_arr[0]);
    }
}
