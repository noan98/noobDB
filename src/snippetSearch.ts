// スニペット一覧の検索まわりの純ロジック (#1631)。副作用なし。
//
// - `snippetMatchesQuery`: 名前・フォルダ・本文・タグのどれかに部分一致するか。
// - `snippetBodyExcerpt`: 本文だけが一致した行に出す、一致箇所前後の抜粋 (理由表示)。
// - `snippetCopyDraft`: 複製用の下書き (id を空にして新規扱い、名前に接尾辞を付ける)。

import type { Snippet } from "./api/tauri";

/** 抜粋に含める一致箇所の前後の文字数。 */
export const SNIPPET_EXCERPT_RADIUS = 40;

/** 複製フォームを「新規」として扱うための空 id。 */
export const SNIPPET_COPY_ID = "";

/** 小文字化済みの検索語 `q` が、名前 / フォルダ / 本文 / タグのどれかに含まれるか。 */
export function snippetMatchesQuery(s: Snippet, q: string): boolean {
  if (!q) return true;
  if (s.name.toLowerCase().includes(q)) return true;
  if (s.folder?.toLowerCase().includes(q)) return true;
  if (s.sql.toLowerCase().includes(q)) return true;
  return s.tags.some((tag) => tag.toLowerCase().includes(q));
}

/**
 * 本文**だけ**が一致した行の抜粋を返す。名前・フォルダ・タグで既に一致している行や、
 * 本文にも一致が無い行は null (理由は一目で分かるので足さない)。連続する空白は 1 つに
 * 畳み、前後が切れているときは「…」を付ける。
 */
export function snippetBodyExcerpt(
  s: Snippet,
  query: string,
  radius: number = SNIPPET_EXCERPT_RADIUS,
): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if (s.name.toLowerCase().includes(q)) return null;
  if (s.folder?.toLowerCase().includes(q)) return null;
  if (s.tags.some((tag) => tag.toLowerCase().includes(q))) return null;
  // 空白を畳んだ本文で探す (改行をまたぐ一致は畳んだ検索語でも拾えるようにする)。
  const flat = s.sql.replace(/\s+/g, " ");
  const idx = flat.toLowerCase().indexOf(q.replace(/\s+/g, " "));
  if (idx < 0) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + q.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/** 複製用の下書き。保存すると新しいスニペットになる (id は空、名前に接尾辞)。 */
export function snippetCopyDraft(s: Snippet, suffix: string): Snippet {
  return { ...s, id: SNIPPET_COPY_ID, name: `${s.name}${suffix}`, tags: [...s.tags] };
}
