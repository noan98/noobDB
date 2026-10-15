// カスタムテーマ (トークン上書き JSON, #1631)。`{ "accent": "#0b5fff", "bg": "#101418" }` のように
// App.css の色トークン (`--accent` など、先頭の `--` は付けても省いてもよい) を 16 進色で上書きする。
// 読み込み時に主要な前景/背景の組へ themeContrast.test.ts と同じ WCAG AA 判定 (accent.ts の contrastRatio)
// をかけ、満たさない組は適用前に警告する。上書きは documentElement のインライン CSS 変数として当てるので、
// どのプリセットの上にも載り、クリアすれば元のテーマへ戻る。

import { contrastRatio } from "./accent";

/** 取り込める上書きの最大件数 (壊れた/巨大なファイルで設定ストアを膨らませない)。 */
export const MAX_CUSTOM_THEME_TOKENS = 120;

export type CustomThemeTokens = Record<string, string>;

const TOKEN_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `#abc` → `#aabbcc`。小文字へそろえる。 */
function normalizeHex(v: string): string {
  const s = v.toLowerCase();
  if (s.length === 4) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return s;
}

/**
 * パース済みの値から妥当なトークンだけ取り出す (設定ストアの読み込みでも使う)。
 * 名前は `--` の有無を問わず、値は 16 進色だけ。それ以外は黙って捨てる。
 */
export function sanitizeCustomTheme(value: unknown): CustomThemeTokens {
  const out: CustomThemeTokens = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [rawName, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_CUSTOM_THEME_TOKENS) break;
    const name = rawName.trim().replace(/^--/, "");
    if (!TOKEN_NAME.test(name)) continue;
    if (typeof rawValue !== "string" || !HEX.test(rawValue.trim())) continue;
    out[name] = normalizeHex(rawValue.trim());
  }
  return out;
}

export type ParseCustomThemeResult =
  | { ok: true; tokens: CustomThemeTokens; ignored: number }
  | { ok: false; reason: "invalid-json" | "not-object" | "empty" };

/**
 * 読み込んだ JSON 文字列をトークンへ。ラップ形式 `{ "tokens": {...} }` も受ける。
 * `ignored` は名前・値が不正で捨てた件数。
 */
export function parseCustomTheme(raw: string): ParseCustomThemeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, reason: "not-object" };
  const obj = parsed as Record<string, unknown>;
  const inner =
    obj.tokens && typeof obj.tokens === "object" && !Array.isArray(obj.tokens) ? obj.tokens : parsed;
  const total = Object.keys(inner as object).length;
  const tokens = sanitizeCustomTheme(inner);
  const kept = Object.keys(tokens).length;
  if (kept === 0) return { ok: false, reason: "empty" };
  return { ok: true, tokens, ignored: total - kept };
}

/** 検証する前景/背景の組。`min` は通常テキスト 4.5:1、UI 部品 3:1 (themeContrast.test.ts と同じ基準)。 */
export const CUSTOM_THEME_CONTRAST_PAIRS: readonly { fg: string; bg: string; min: number }[] = [
  { fg: "text", bg: "bg", min: 4.5 },
  { fg: "text", bg: "bg-elevated", min: 4.5 },
  { fg: "text-secondary", bg: "bg", min: 4.5 },
  { fg: "text-muted", bg: "bg", min: 4.5 },
  { fg: "text-null", bg: "bg-elevated", min: 4.5 },
  { fg: "accent", bg: "bg", min: 4.5 },
  { fg: "accent-text", bg: "accent", min: 4.5 },
  { fg: "text-error", bg: "bg", min: 4.5 },
  { fg: "text-warning", bg: "bg", min: 4.5 },
  { fg: "text-success", bg: "bg", min: 4.5 },
  { fg: "syntax-keyword", bg: "bg-input", min: 4.5 },
  { fg: "syntax-string", bg: "bg-input", min: 4.5 },
  { fg: "syntax-comment", bg: "bg-input", min: 4.5 },
  { fg: "text", bg: "bg-active", min: 4.5 },
  { fg: "status-idle", bg: "bg", min: 3 },
];

export interface ContrastFailure {
  fg: string;
  bg: string;
  fgColor: string;
  bgColor: string;
  ratio: number;
  min: number;
}

/**
 * 上書き後の色でコントラストが足りない組を返す。`baseOf(name)` は上書きされていないトークンの
 * 現在値 (16 進以外や未定義なら null を返すとその組は判定しない)。上書きに関係しない組は
 * 既存テーマの責務なので、前景か背景のどちらかが上書き対象の組だけ見る。
 */
export function findContrastFailures(
  tokens: CustomThemeTokens,
  baseOf: (name: string) => string | null,
): ContrastFailure[] {
  const out: ContrastFailure[] = [];
  for (const pair of CUSTOM_THEME_CONTRAST_PAIRS) {
    if (!(pair.fg in tokens) && !(pair.bg in tokens)) continue;
    const fgRaw = tokens[pair.fg] ?? baseOf(pair.fg);
    const bgRaw = tokens[pair.bg] ?? baseOf(pair.bg);
    if (!fgRaw || !bgRaw || !HEX.test(fgRaw.trim()) || !HEX.test(bgRaw.trim())) continue;
    const fgColor = normalizeHex(fgRaw.trim());
    const bgColor = normalizeHex(bgRaw.trim());
    const ratio = contrastRatio(fgColor, bgColor);
    if (ratio < pair.min) out.push({ fg: pair.fg, bg: pair.bg, fgColor, bgColor, ratio, min: pair.min });
  }
  return out;
}

/** インライン CSS 変数としてテーマ上書きを当てる。戻り値は後片付け関数。 */
export function applyCustomThemeVars(root: HTMLElement, tokens: CustomThemeTokens): () => void {
  const names = Object.keys(tokens);
  for (const n of names) root.style.setProperty(`--${n}`, tokens[n]);
  return () => {
    for (const n of names) root.style.removeProperty(`--${n}`);
  };
}

/**
 * 上書きを一時的に外して、現在のテーマが持つトークンの値を読む (判定用)。
 * 読んだら元の上書きを戻すので画面はちらつかない (同期処理)。
 */
export function readBaseThemeToken(
  root: HTMLElement,
  active: CustomThemeTokens,
): (name: string) => string | null {
  const saved: [string, string][] = [];
  for (const n of Object.keys(active)) {
    saved.push([n, root.style.getPropertyValue(`--${n}`)]);
    root.style.removeProperty(`--${n}`);
  }
  const cs = getComputedStyle(root);
  const cache = new Map<string, string | null>();
  const wanted = new Set<string>();
  for (const p of CUSTOM_THEME_CONTRAST_PAIRS) {
    wanted.add(p.fg);
    wanted.add(p.bg);
  }
  for (const n of wanted) {
    const v = cs.getPropertyValue(`--${n}`).trim();
    cache.set(n, v || null);
  }
  for (const [n, v] of saved) if (v) root.style.setProperty(`--${n}`, v);
  return (name) => cache.get(name) ?? null;
}
