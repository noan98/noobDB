// AI の追い質問 (#1471) の会話組み立て。純関数だけを置く (副作用は各画面が持つ)。
// 1 往復 = 「実際に送ったユーザプロンプト」と「モデルが返した本文 (構造化出力の JSON)」。
// 送信範囲 (スキーマのみ / リテラルマスク) の方針は、往復を記録する時点で適用済みの
// 文字列をそのまま保存することで守る (履歴を後から組み直さないので、マスク前の SQL が混ざらない)。

/** `run_ai_request` の `history` に渡す 1 発言。 */
export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** 1 往復 (送ったプロンプトと、得られた回答の本文)。 */
export interface AiExchange {
  prompt: string;
  answer: string;
}

/** 履歴に含める往復数の上限 (直近 N 往復)。 */
export const MAX_HISTORY_EXCHANGES = 5;

/**
 * system / prompt / 履歴を合算した送信サイズの上限 (バイト)。
 * バックエンド (`commands/ai.rs` の `MAX_PROMPT_BYTES`) と同じ値。
 */
export const MAX_PROMPT_BYTES = 1024 * 1024;

const encoder = new TextEncoder();

function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** 往復の追加。上限を超えた古い往復は捨てる (表示用の状態が際限なく伸びないように)。 */
export function appendExchange(exchanges: readonly AiExchange[], next: AiExchange): AiExchange[] {
  return [...exchanges, next].slice(-MAX_HISTORY_EXCHANGES);
}

export interface BuildHistoryOptions {
  /** 履歴に含める往復数の上限。既定は `MAX_HISTORY_EXCHANGES`。 */
  maxExchanges?: number;
  /** 履歴に使えるバイト数 (上限 - system - 今回のプロンプト)。既定は `MAX_PROMPT_BYTES`。 */
  maxBytes?: number;
}

/**
 * 履歴に載せる往復を選ぶ。直近 `maxExchanges` 往復に絞り、さらにバイト数が `maxBytes` を
 * 超える間は古い往復から往復単位で捨てる (user だけ・assistant だけが残って交互が崩れることは
 * ない)。空の往復 (プロンプトか回答が空) は API が拒否するので含めない。
 */
export function trimExchanges(
  exchanges: readonly AiExchange[],
  options: BuildHistoryOptions = {},
): AiExchange[] {
  const maxExchanges = Math.max(0, options.maxExchanges ?? MAX_HISTORY_EXCHANGES);
  const maxBytes = options.maxBytes ?? MAX_PROMPT_BYTES;
  const usable = exchanges.filter((e) => e.prompt.trim() !== "" && e.answer.trim() !== "");
  let kept = maxExchanges === 0 ? [] : usable.slice(-maxExchanges);
  const size = (list: readonly AiExchange[]) =>
    list.reduce((n, e) => n + byteLength(e.prompt) + byteLength(e.answer), 0);
  while (kept.length > 0 && size(kept) > maxBytes) kept = kept.slice(1);
  return kept;
}

/** 往復の列を `messages` 用の発言 (user / assistant 交互) に展開する。 */
export function exchangesToMessages(exchanges: readonly AiExchange[]): AiChatMessage[] {
  return exchanges.flatMap<AiChatMessage>((e) => [
    { role: "user", content: e.prompt },
    { role: "assistant", content: e.answer },
  ]);
}

/** `trimExchanges` + `exchangesToMessages`。`run_ai_request` の `history` にそのまま渡せる。 */
export function buildHistory(
  exchanges: readonly AiExchange[],
  options: BuildHistoryOptions = {},
): AiChatMessage[] {
  return exchangesToMessages(trimExchanges(exchanges, options));
}

/** 履歴に回せるバイト数。system / 今回のプロンプトの分を上限から引く (負にはしない)。 */
export function historyBudget(...reserved: Array<string | null | undefined>): number {
  const used = reserved.reduce<number>((n, s) => n + (s ? byteLength(s) : 0), 0);
  return Math.max(0, MAX_PROMPT_BYTES - used);
}
