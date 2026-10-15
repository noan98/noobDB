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
//! - `budget`: 月次予算の判定 (#1620)。台帳の月初からの概算コストが予算以上なら実行前に止める。
//! - `usage`: 使用量台帳 (日 × タスク × モデルのトークン数、#1540)。数値のみ保存する。

pub mod budget;
pub mod client;
pub mod models;
pub mod request;
pub mod sse;
pub mod usage;
