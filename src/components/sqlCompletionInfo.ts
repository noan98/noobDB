import type { ColumnInfoView } from "./sqlCompletionSchema";

/** 情報パネルの表示語 (ロケール変換は呼び出し側で済ませる)。 */
export interface ColumnInfoLabels {
  nullable: string;
  notNull: string;
  primaryKey: string;
  /** FK 参照先の文言。 */
  foreignKey: (target: string) => string;
}

/**
 * 補完ポップアップの列情報パネルの DOM を作る。色・余白・影は `App.css` の
 * `.cm-completionInfoPanel*` クラスが `var()` で与えるので、ここでは直値を書かない。
 */
export function buildColumnInfoDom(view: ColumnInfoView, labels: ColumnInfoLabels): HTMLElement {
  const root = document.createElement("div");
  root.className = "cm-completionInfoPanel";
  const row = (cls: string, text: string) => {
    const el = document.createElement("div");
    el.className = `cm-completionInfoRow ${cls}`;
    el.textContent = text;
    root.appendChild(el);
  };
  if (view.dataType) row("cm-completionInfoType", view.dataType);
  const flags: string[] = [];
  if (view.nullable !== null) flags.push(view.nullable ? labels.nullable : labels.notNull);
  if (view.primaryKey) flags.push(labels.primaryKey);
  if (flags.length > 0) row("cm-completionInfoFlags", flags.join(" · "));
  if (view.references) row("cm-completionInfoFk", labels.foreignKey(view.references));
  return root;
}
