// ヘルプの機能カードから該当画面を直接開く『試す』ボタン (#1631) の行き先。
// HelpView は行き先を決めるだけで、実際に開く処理は App が持つ (`onOpenFeature`)。

export type HelpTryTarget =
  /** 新しいクエリタブ (接続が必要)。 */
  | { kind: "newQuery" }
  /** 設定画面の指定セクション (`settings-sec-*`)。 */
  | { kind: "settings"; section: string }
  /** 全画面サーフェスなど、他のビュー。 */
  | { kind: "view"; view: "compare" | "tasks" | "newConnection" };
