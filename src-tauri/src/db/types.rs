use serde::{Deserialize, Serialize};

/// DB-agnostic value type returned to the frontend as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
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
}

impl QueryResult {
    pub fn empty(rows_affected: u64, elapsed_ms: u64) -> Self {
        Self {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected,
            elapsed_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub key: String,
    pub default: Option<String>,
    pub extra: String,
}
