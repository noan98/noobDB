use std::path::PathBuf;

use serde::Deserialize;
use tokio::fs;

use crate::db::types::{Column, Value};
use crate::error::{AppError, Result};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
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
    let buf = match format {
        ExportFormat::Csv => render_csv(&columns, &rows),
        ExportFormat::Json => render_json(&columns, &rows)?,
    };
    let p = PathBuf::from(&path);
    fs::write(&p, &buf).await?;
    Ok(buf.len() as u64)
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

fn render_csv(columns: &[Column], rows: &[Vec<Value>]) -> Vec<u8> {
    let mut out = String::new();
    let header: Vec<String> = columns.iter().map(|c| csv_field(&c.name)).collect();
    out.push_str(&header.join(","));
    out.push_str("\r\n");
    for row in rows {
        let mut first = true;
        for i in 0..columns.len() {
            if !first {
                out.push(',');
            }
            first = false;
            let v = row.get(i).cloned().unwrap_or(Value::Null);
            out.push_str(&value_to_csv(&v));
        }
        out.push_str("\r\n");
    }
    out.into_bytes()
}

fn render_json(columns: &[Column], rows: &[Vec<Value>]) -> Result<Vec<u8>> {
    use serde_json::{Map, Value as J};

    let mut arr: Vec<J> = Vec::with_capacity(rows.len());
    for row in rows {
        let mut obj = Map::with_capacity(columns.len());
        for (i, col) in columns.iter().enumerate() {
            let v = row.get(i).cloned().unwrap_or(Value::Null);
            let jv = match v {
                Value::Bytes(ref hex) => J::String(format!("0x{}", hex)),
                _ => serde_json::to_value(&v).unwrap_or(J::Null),
            };
            obj.insert(col.name.clone(), jv);
        }
        arr.push(J::Object(obj));
    }
    let bytes = serde_json::to_vec_pretty(&arr)?;
    Ok(bytes)
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
        let out = String::from_utf8(render_csv(&columns, &rows)).unwrap();
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
        let out = render_json(&columns, &rows).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(parsed[0]["id"], serde_json::json!(7));
        assert_eq!(parsed[0]["blob"], serde_json::json!("0xdeadbeef"));
        assert_eq!(parsed[1]["id"], serde_json::Value::Null);
        assert_eq!(parsed[1]["blob"], serde_json::Value::Null);
    }
}
