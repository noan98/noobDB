import type { ColumnInfoContent } from "./sqlSchemaCompletion";

/**
 * 列候補の情報パネル (#1413) の DOM を組み立てる。CodeMirror の `Completion.info` は
 * DOM 要素を返す仕組みなので React は使わない。スタイルは `App.css` の `.cm-sqlInfo*`
 * (CSS 変数のみ)。文言は呼び出し側が i18n で解決済みの `ColumnInfoContent` で渡す。
 */
export function renderColumnInfo(content: ColumnInfoContent): HTMLElement {
  const root = document.createElement("div");
  root.className = "cm-sqlInfo";
  const title = document.createElement("div");
  title.className = "cm-sqlInfo-title";
  title.textContent = content.title;
  root.append(title);
  const list = document.createElement("dl");
  list.className = "cm-sqlInfo-rows";
  for (const row of content.rows) {
    const dt = document.createElement("dt");
    dt.textContent = row.label;
    const dd = document.createElement("dd");
    dd.textContent = row.value;
    list.append(dt, dd);
  }
  root.append(list);
  if (content.comment) {
    const comment = document.createElement("div");
    comment.className = "cm-sqlInfo-comment";
    comment.textContent = content.comment;
    root.append(comment);
  }
  return root;
}
