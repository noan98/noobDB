/**
 * 結果グリッド上の機微カラム表示マスキング (#1069) の純ロジック。
 *
 * 画面共有・デモ・ペア作業中に `email` / `token` / `ssn` のような機微カラムを
 * グリッド上で伏せ字 (`••••`) にする。**表示専用**で、実値・ソート・編集バッファ・
 * エクスポート内容は一切変えない (`cellConditionalFormat` と同方針)。
 *
 * マスク対象の決定規則:
 *   1. 機能全体が無効 (`settings.columnMaskEnabled === false`) なら何もマスクしない。
 *   2. 列ヘッダメニューで列単位に明示した上書き (`overrides[列名]`) があればそれに従う
 *      (パターン一致列を個別に外す / 非一致列を個別に伏せる の両方向)。
 *   3. それ以外は列名がパターン (`settings.columnMaskPatterns`) に一致すればマスク。
 *
 * パターンは大文字小文字を区別せず、`*` / `?` を含まないものは**部分一致**
 * (`email` は `user_email` / `EmailAddress` に一致)、含むものは列名全体に対する
 * グロブとして扱う (`*_id` / `pin` のような短い語を厳密にしたいとき用)。
 *
 * 一時 reveal は「セル 1 つ」または「列全体」を対象に、`REVEAL_TIMEOUT_MS` 後と
 * ウィンドウのフォーカス喪失時に自動で再マスクする (`reveal_profile_secret` #938 の
 * 30 秒自動再マスクと同じ発想)。タイマー/イベント結線は `ResultGrid` 側で、ここは
 * 判定だけを持つ。
 *
 * マスク中 (= マスク対象かつ未 reveal) のセルに対する他経路の扱い — 曖昧なところは
 * すべて「伏せ字のまま漏らさない」側に倒している:
 *   - コピー (セル/行/TSV 選択): 設定 `columnMaskCopyPlaceholder` (既定オン) で
 *     プレースホルダをコピーする (`maskedCopyText`)。オフなら実値。
 *   - 「INSERT/UPDATE/DELETE としてコピー」: プレースホルダを SQL に埋めると壊れた
 *     SQL になるため、コピーをプレースホルダにする設定の間は項目自体を無効化。
 *   - 行の複製・値ビューア・行インスペクタ・列の統計・集計フッター・選択サマリ:
 *     実値を画面に出す経路なので、マスク中の値は出さない (無効化 / 伏せ字)。
 *   - インライン編集の開始: 編集欄は実値を初期表示するため、reveal するまで開始しない。
 *     値を**書き込むだけ**で実値を表示しない経路 (クイックセット・Delete で NULL・
 *     貼り付け・一括編集) はそのまま使える。保留中の編集値も伏せ字で表示する。
 *   - エクスポート: 受け入れ条件どおり内容は不変 (エクスポートは明示的な出力操作で、
 *     マスキングは #733 の担当)。
 */

/** 伏せ字の表示文字列。値の長さを漏らさないよう常に固定長。 */
export const MASK_PLACEHOLDER = "••••";

/** 一時 reveal の自動再マスクまでの時間 (ms)。#938 の秘密 reveal と揃えて 30 秒。 */
export const REVEAL_TIMEOUT_MS = 30_000;

/** 既定のマスク対象パターン (部分一致・大文字小文字無視)。 */
export const DEFAULT_MASK_PATTERNS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "ssn",
  "email",
  "credit_card",
  "card_number",
];

/** 1 パターンあたりの最大長。これを超えるものは捨てる (設定ファイル破損への耐性)。 */
const MAX_PATTERN_LENGTH = 100;
/** パターンの最大件数。 */
const MAX_PATTERNS = 100;

/**
 * パターン配列を正規化する: 文字列以外・空文字・長すぎるものを捨て、前後空白を
 * 除き小文字化し、重複を除く (先勝ち)。`raw` が配列でなければ `fallback`。
 */
export function sanitizeMaskPatterns(raw: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (typeof p !== "string") continue;
    const s = p.trim().toLowerCase();
    if (s.length === 0 || s.length > MAX_PATTERN_LENGTH || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_PATTERNS) break;
  }
  return out;
}

/** 設定画面の入力 (カンマ/改行区切り) をパターン配列へ。 */
export function parseMaskPatterns(text: string): string[] {
  return sanitizeMaskPatterns(text.split(/[,\n]/), []);
}

/** パターン配列を設定画面の入力欄用の文字列へ。 */
export function formatMaskPatterns(patterns: readonly string[]): string {
  return patterns.join(", ");
}

function globToRegExp(glob: string): RegExp {
  let src = "";
  for (const ch of glob) {
    if (ch === "*") src += ".*";
    else if (ch === "?") src += ".";
    else src += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`);
}

/** 列名がパターンのいずれかに一致するか (大文字小文字無視)。 */
export function matchesMaskPattern(columnName: string, patterns: readonly string[]): boolean {
  const name = columnName.toLowerCase();
  for (const raw of patterns) {
    const p = raw.trim().toLowerCase();
    if (p.length === 0) continue;
    if (p.includes("*") || p.includes("?")) {
      if (globToRegExp(p).test(name)) return true;
    } else if (name.includes(p)) {
      return true;
    }
  }
  return false;
}

/** 列ヘッダメニューでの列単位の上書き (列名 → マスクする/しない)。 */
export type MaskOverrides = Record<string, boolean>;

export interface MaskConfig {
  /** 機能全体の ON/OFF。 */
  enabled: boolean;
  /** 自動マスクのパターン。 */
  patterns: readonly string[];
  /** 列単位の上書き。 */
  overrides?: MaskOverrides;
}

/** 列名 1 つがマスク対象か。 */
export function isColumnMasked(columnName: string, config: MaskConfig): boolean {
  if (!config.enabled) return false;
  const o = config.overrides?.[columnName];
  if (typeof o === "boolean") return o;
  return matchesMaskPattern(columnName, config.patterns);
}

/**
 * 全列のマスクフラグ (列インデックス順)。1 列もマスクされないときは `null` を返し、
 * 描画側が「マスク無し」を 1 回の null 判定で素通りできるようにする (列仮想化された
 * セル描画のホットパスに余計な配列参照を足さないため)。
 */
export function resolveMaskedColumns(
  columnNames: readonly string[],
  config: MaskConfig,
): boolean[] | null {
  if (!config.enabled) return null;
  let any = false;
  const flags = columnNames.map((n) => {
    const m = isColumnMasked(n, config);
    if (m) any = true;
    return m;
  });
  return any ? flags : null;
}

/**
 * 列単位のマスク切替。パターンの判定結果と同じになる上書きは保存しない
 * (既定に戻すと上書きが消え、パターン設定の変更に再び追従する)。
 */
export function toggleMaskOverride(
  overrides: MaskOverrides,
  columnName: string,
  patterns: readonly string[],
  nextMasked: boolean,
): MaskOverrides {
  const next = { ...overrides };
  if (matchesMaskPattern(columnName, patterns) === nextMasked) delete next[columnName];
  else next[columnName] = nextMasked;
  return next;
}

/** 一時 reveal の対象。セル 1 つ (元の行インデックス + 列インデックス) か列全体。 */
export type RevealTarget =
  | { kind: "cell"; rowIdx: number; colIdx: number }
  | { kind: "column"; colIdx: number };

/** セルが reveal 中か。 */
export function isCellRevealed(
  reveal: RevealTarget | null,
  rowIdx: number,
  colIdx: number,
): boolean {
  if (!reveal || reveal.colIdx !== colIdx) return false;
  return reveal.kind === "column" || reveal.rowIdx === rowIdx;
}

/** セルが「マスク中」(= マスク対象かつ未 reveal) か。 */
export function isCellMasked(
  masked: readonly boolean[] | null,
  reveal: RevealTarget | null,
  rowIdx: number,
  colIdx: number,
): boolean {
  if (!masked || !masked[colIdx]) return false;
  return !isCellRevealed(reveal, rowIdx, colIdx);
}

/** 行の中にマスク中のセルがあるか (SQL コピー・行の複製の無効化判定)。 */
export function rowHasMaskedCell(
  masked: readonly boolean[] | null,
  reveal: RevealTarget | null,
  rowIdx: number,
  colCount: number,
): boolean {
  if (!masked) return false;
  for (let c = 0; c < colCount; c++) {
    if (isCellMasked(masked, reveal, rowIdx, c)) return true;
  }
  return false;
}

/**
 * コピー用テキスト。マスク中かつ設定でプレースホルダコピーが有効なら伏せ字、
 * そうでなければ実値のテキスト (`realText`)。
 */
export function maskedCopyText(
  realText: string,
  cellMasked: boolean,
  copyPlaceholder: boolean,
): string {
  return cellMasked && copyPlaceholder ? MASK_PLACEHOLDER : realText;
}
