/**
 * アプリ内自動更新 (#705) の「表示・整形」まわりの純粋ロジック。実際の Tauri
 * プラグイン呼び出し (`@tauri-apps/plugin-updater` / `plugin-process`) は
 * `updater.ts` に分離し、ここは副作用なし・Vitest で境界値を固定できる関数だけを
 * 持つ (通知の `queryNotify.ts` ⇔ `notifications.ts` と同じ分離方針)。
 */
import type { I18nKey } from "./i18n";
import { formatBytes } from "./components/tableSize";
import { takeGraphemes } from "./truncateText";

/**
 * ダウンロード進捗をパーセント (0〜100 の整数) に変換する。合計サイズが不明
 * (0 以下 / 未指定 / 非有限) のときは `null` を返し、呼び出し側は「不定進捗」
 * として扱う。ダウンロード済みが合計を超えても 100 でクランプする。
 */
export function downloadProgressPercent(
  downloaded: number,
  contentLength: number | undefined,
): number | null {
  if (contentLength === undefined) return null;
  if (!Number.isFinite(contentLength) || contentLength <= 0) return null;
  if (!Number.isFinite(downloaded) || downloaded <= 0) return 0;
  const pct = Math.round((downloaded / contentLength) * 100);
  return Math.max(0, Math.min(100, pct));
}

/**
 * リリースノート (更新の `body`) を確認ダイアログ向けに整える。更新マニフェストは
 * 外部 (GitHub Releases) 由来なので、長大な本文で UI を壊さないよう先頭
 * `maxLen` 文字に切り詰め、前後の空白を落とす。空/未指定なら空文字を返す。
 */
export function truncateReleaseNotes(body: string | undefined, maxLen = 600): string {
  if (!body) return "";
  const trimmed = body.trim();
  if (trimmed.length <= maxLen) return trimmed;
  // 書記素クラスタ単位で切る: コード単位 (#1534) やコードポイント単位だと、サロゲートペアや
  // 旗絵文字・ZWJ 列の途中で割れて末尾に孤立した文字が残る (#1604)。
  const head = takeGraphemes(trimmed, maxLen);
  if (head === null) return trimmed;
  return `${head}…`;
}

/** 要点の帯の意味色 (GitHub の alert 記法 `[!NOTE]` 等に対応)。 */
export type HighlightTone = "info" | "success" | "warning" | "danger";

/** 「新機能ハイライト」(#1864) で描くリリースノートの 1 ブロック。 */
export type ReleaseNoteBlock =
  | { kind: "heading"; text: string }
  | { kind: "highlight"; text: string; tone: HighlightTone }
  | { kind: "bullet"; text: string }
  | { kind: "code"; text: string }
  | { kind: "paragraph"; text: string };

const ALERT_TONES: Record<string, HighlightTone> = {
  NOTE: "info",
  IMPORTANT: "info",
  TIP: "success",
  WARNING: "warning",
  CAUTION: "danger",
};

/** 行内の Markdown 記法 (画像・リンク・太字・コード) を素のテキストへ落とす。HTML は解釈せず文字のまま出す。 */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/**
 * リリースノート (GitHub Releases 由来の簡易 Markdown) を表示用ブロックへ分解する。
 *   - `#`〜`######` の見出し -> heading、連続する `> ` 引用 -> 1 つの highlight (先頭行が
 *     `[!NOTE]` / `[!TIP]` / `[!WARNING]` / `[!CAUTION]` / `[!IMPORTANT]` ならその行は捨てて tone に反映)、
 *     `-` / `*` / `+` / `1.` の箇条書き -> bullet、``` で囲んだ範囲 -> code、
 *     それ以外の連続行 -> paragraph (改行は保つ)。水平線と画像は捨てる。
 *   - 外部由来なので先に `truncateReleaseNotes` で切り詰める (既定 2000 文字)。
 *   - 空/未指定、記号だけの行しか無いときは空配列。
 */
export function parseReleaseNotes(body: string | undefined, maxLen = 2000): ReleaseNoteBlock[] {
  const text = truncateReleaseNotes(body, maxLen).replace(/\r\n?/g, "\n");
  if (!text) return [];
  const blocks: ReleaseNoteBlock[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let fence: string[] | null = null;
  const flushPara = () => {
    if (para.length > 0) blocks.push({ kind: "paragraph", text: para.join("\n") });
    para = [];
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    let tone: HighlightTone = "info";
    const alert = quote[0]?.match(/^\[!(\w+)\]$/);
    const mapped = alert ? ALERT_TONES[(alert[1] ?? "").toUpperCase()] : undefined;
    if (mapped) {
      tone = mapped;
      quote = quote.slice(1);
    }
    const v = quote.join(" ").trim();
    if (v) blocks.push({ kind: "highlight", text: v, tone });
    quote = [];
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if (fence) {
      if (line.startsWith("```")) {
        if (fence.length > 0) blocks.push({ kind: "code", text: fence.join("\n") });
        fence = null;
      } else {
        fence.push(raw.replace(/\s+$/, ""));
      }
    } else if (line.startsWith("```")) {
      flushAll();
      fence = [];
    } else if (line === "") {
      flushAll();
    } else if (/^([-*_])(\s*\1){2,}$/.test(line)) {
      flushAll(); // 水平線
    } else if ((m = line.match(/^#{1,6}(?:\s+(.*))?$/))) {
      flushAll();
      const v = stripInlineMarkdown(m[1] ?? "");
      if (v) blocks.push({ kind: "heading", text: v });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara();
      const v = stripInlineMarkdown(m[1] ?? "");
      if (v) quote.push(v);
    } else if ((m = line.match(/^(?:[-*+]|\d+\.)(?:\s+(.*))?$/))) {
      flushAll();
      const v = stripInlineMarkdown(m[1] ?? "");
      if (v) blocks.push({ kind: "bullet", text: v });
    } else {
      flushQuote();
      const v = stripInlineMarkdown(line);
      if (v) para.push(v);
    }
  }
  // 閉じ忘れのフェンス (切り詰めで閉じが落ちた場合) も中身は出す。
  if (fence && fence.length > 0) blocks.push({ kind: "code", text: fence.join("\n") });
  flushAll();
  return blocks;
}

/**
 * バージョン文字列を表示用に整える。updater が返す `version` には稀に先頭 `v` が
 * 付くことがあるため取り除き、前後空白も落とす。空なら `?` にフォールバックして
 * UI 側の undefined 表示を防ぐ。
 */
export function displayVersion(version: string | undefined | null): string {
  if (!version) return "?";
  const v = version.trim().replace(/^v/i, "");
  return v.length > 0 ? v : "?";
}

/**
 * ダウンロード進捗トーストの文言。合計サイズが不明 (percent が null) のときは null を返し、
 * 呼び出し側は最初の不定表示のままにする。
 */
export function formatDownloadProgress(
  p: { percent: number | null; downloadedBytes: number; totalBytes: number | undefined },
  t: (key: I18nKey, vars?: Record<string, string | number>) => string,
): string | null {
  if (p.percent === null || p.totalBytes === undefined) return null;
  return t("updateDownloadingProgress", {
    percent: p.percent,
    downloaded: formatBytes(p.downloadedBytes),
    total: formatBytes(p.totalBytes),
  });
}
