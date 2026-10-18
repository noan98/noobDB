// スニペット本文のタブストップ記法 (#1489)。副作用なし・フロント内で完結する純ロジック。
//
// エディタへ差し込むとき、本文中の次の記法を CodeMirror の snippet (Tab / Shift+Tab で
// フィールド間を移動) に載せる。
//
//   ${1:既定値}   番号付きフィールド。既定値が選択状態で挿入される
//   ${1}          番号付きフィールド (既定値なし)。同じ番号は連動する (ミラー)
//   ${name}       名前付きフィールド。名前がそのまま既定値になる (同名は連動。名前に
//                 既定値は付けられない: `${name:x}` は記法ではなく文字どおり残る)
//   ${0}          最後にカーソルを置く位置 (番号 0 は他のフィールドの後)
//   \${           記法ではなく文字どおりの `${`
//
// 後方互換のための決めごと (既存スニペットを壊さない):
//   - 素の `$1` / `$$` / `$tag$` は**タブストップにしない**。PostgreSQL のパラメータ
//     (`WHERE id = $1`) やドル引用 (`$$ ... $$`) と衝突するため、必ず波括弧付きの `${…}`
//     だけを記法とする。
//   - `{{name}}` (実行時パラメータ、queryParams.ts) は `$` を伴わないので触れない。
//     `${{name}}` も `${` の直後が `{` なので記法ではなく、そのまま残る。
//   - `${` で始まっても上の形に当てはまらないもの (`${ x }` / `${1:{}}` / 閉じ括弧なし)
//     は記法ではなく文字どおりに残す。既定値には `{` `}` を含められない。
//   - 既定値は 1 行に収まるものだけ (CodeMirror が行をまたぐフィールドを扱えないため)。
//     改行を含む `${1:a⏎b}` は記法ではなく文字どおり残す。
//   - 記法を 1 つも含まない本文は原文のまま丸ごと挿入し、カーソルは末尾に来る。`\${` の
//     エスケープも**記法を含む本文でだけ**効く (含まない本文は `\${` もそのまま)。

/** 本文を分解した 1 片。 */
export type SnippetPart =
  | { kind: "text"; text: string }
  | { kind: "field"; key: string; index: number | null; name: string | null; placeholder: string };

/**
 * フィールド記法: `${1}` `${1:x}` `${name}`。名前は識別子形 (英字 / _ で始まる)。
 * 番号は 4 桁まで (CodeMirror は `${0}` を内部で 1e9 として扱うため、巨大な番号は最後の位置と衝突する)。
 */
const FIELD_RE = /\$\{(?:(\d{1,4})(?::([^{}\r\n]*))?|([A-Za-z_]\w*))\}/y;

/** 本文をテキストとフィールドの列に分解する。 */
export function parseSnippetTemplate(src: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) parts.push({ kind: "text", text: buf });
    buf = "";
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && src.startsWith("${", i + 1)) {
      buf += "${";
      i += 3;
      continue;
    }
    if (ch === "$" && src[i + 1] === "{") {
      FIELD_RE.lastIndex = i;
      const m = FIELD_RE.exec(src);
      if (m) {
        flush();
        const index = m[1] !== undefined ? Number(m[1]) : null;
        const name = m[3] ?? null;
        parts.push({
          kind: "field",
          key: index !== null ? `n:${index}` : `s:${name}`,
          index,
          name,
          placeholder: m[2] ?? "",
        });
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return parts;
}

/** 本文がタブストップ記法を 1 つでも含むか。 */
export function snippetHasFields(src: string): boolean {
  return parseSnippetTemplate(src).some((p) => p.kind === "field");
}

/**
 * フィールドごとの既定値。同じ番号 / 名前が複数あるときは、最初に空でない既定値を
 * 持つ出現を採る (連動するフィールドは同じ初期表示にそろう)。名前付きで既定値が
 * 無いときは名前そのもの。
 */
function resolveDefaults(parts: SnippetPart[]): Map<string, string> {
  const defaults = new Map<string, string>();
  for (const p of parts) {
    if (p.kind !== "field") continue;
    const current = defaults.get(p.key);
    if (current) continue;
    defaults.set(p.key, p.placeholder || p.name || "");
  }
  return defaults;
}

/**
 * タブストップを使わない場面 (新規タブ・実行・プレビュー) 向けの平文。フィールドは
 * 既定値に置き換え、`\${` は `${` に戻す。記法を含まない本文はそのまま返す。
 */
export function snippetPlainText(src: string): string {
  const parts = parseSnippetTemplate(src);
  // 記法を含まない本文は原文のまま (`\${` を含む既存 SQL を書き換えない)。
  if (!parts.some((p) => p.kind === "field")) return src;
  const defaults = resolveDefaults(parts);
  return parts.map((p) => (p.kind === "text" ? p.text : (defaults.get(p.key) ?? ""))).join("");
}

/**
 * CodeMirror の `snippet()` に渡すテンプレートへ変換する。CodeMirror の記法は
 * `{` `}` を `\{` `\}` でエスケープするので、**文字どおりのテキスト中の波括弧**を
 * エスケープして、`{{name}}` や JSON 風の `{"a":1}` が誤ってフィールドと解釈されない
 * ようにする。それ以外 (バックスラッシュ・`$`・`#`) は触らない。
 */
export function snippetToCodeMirrorTemplate(src: string): string {
  const parts = parseSnippetTemplate(src);
  const defaults = resolveDefaults(parts);
  // 名前付きフィールドには番号を振る。CodeMirror は `${0}` (最終位置) を名前付きより先に
  // 巡回してしまうので、本文中の最大番号 + 1, +2, … を出現順に割り当てる (同名は同番号)。
  let next = Math.max(0, ...parts.map((p) => (p.kind === "field" && p.index ? p.index : 0))) + 1;
  const named = new Map<string, number>();
  return parts
    .map((p) => {
      if (p.kind === "text") return p.text.replace(/[{}]/g, (b) => `\\${b}`);
      const d = defaults.get(p.key) ?? "";
      if (p.index !== null) return d ? `\${${p.index}:${d}}` : `\${${p.index}}`;
      // 名前付きは名前がそのまま既定値 (表示名)。
      let n = named.get(p.key);
      if (n === undefined) {
        n = next++;
        named.set(p.key, n);
      }
      return `\${${n}:${d}}`;
    })
    .join("");
}
