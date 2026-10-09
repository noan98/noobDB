//! AI 基盤 (#690)。Epic #689 の全 AI 機能が乗る共通層。
//!
//! Rust には公式 Anthropic SDK が無いため、`reqwest` で Messages API
//! (`POST https://api.anthropic.com/v1/messages`) を直接叩く薄いクライアントを持つ。
//!
//! - `models`: モデル・タスク種別・エフォートの定義と、設定スナップショットからの解決
//!   (純関数。テスト可能)。
//! - `request`: リクエスト JSON の組み立て (現行モデル共通の要件をここで吸収する)。
//! - `sse`: SSE 行のパースと、Anthropic のストリームイベント → 内部イベントの変換。
//! - `client`: HTTP 層 (`AiTransport` でスタブ可能) と、ストリーミング / 非ストリーミング
//!   の実行ロジック (refusal・usage・フォールバックモデルの扱い)。

pub mod client;
pub mod models;
pub mod request;
pub mod sse;
