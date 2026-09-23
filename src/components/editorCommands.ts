/**
 * SQL Editor / 接続まわりの操作をコマンドパレットへ出す候補の組み立て
 * (#1113 / Epic #1110 Phase 3)。
 *
 * 「SQL → Execute → Result」の導線 (実行・選択実行・整形・EXPLAIN) を、ツールバーや
 * ショートカットだけでなくパレットからも同じ操作で辿れるようにする。実行はすべて
 * 渡された関数 (アクティブなエディタのハンドル経由でツールバーと同じ経路) が担い、
 * ここは可用条件とラベル・検索語だけを決める。副作用なし。
 *
 * - 実行系は「接続中」かつ「エディタを持つタブがある」ときだけ出す。
 * - 整形はエディタ内で完結するので接続を要求しない。
 * - EXPLAIN タブではエディタの主要アクションが既に EXPLAIN なので「EXPLAIN」を
 *   重ねて出さない (エディタの右クリックメニューと同じ判断)。
 * - 「接続を切り替え」は背景で開いたままの接続 (#同時接続) だけを候補にする。
 *   未接続のプロファイルへの接続は従来どおり `conn:` 候補 (接続グループ) が担う。
 */

import type { I18nKey } from "../i18n";
import type { CommandItem } from "./commandPaletteSearch";

export interface EditorCommandContext {
  sessionId: string | null;
  /** エディタを持つタブがアクティブか。 */
  hasEditor: boolean;
  /** アクティブタブが EXPLAIN タブか。 */
  explainTab: boolean;
  /** 開いている接続 (アクティブ + 背景)。`active` はいま前面にある接続。 */
  openConnections: readonly { profileId: string; name: string; driver: string; active: boolean }[];
  /** 表示用に解決済みのショートカット (`formatCombo` の戻り値)。 */
  shortcuts: {
    run?: string;
    runStatement?: string;
    format?: string;
    explain?: string;
  };
}

export interface EditorCommandActions {
  runAll: () => void;
  runStatement: () => void;
  formatSql: () => void;
  explain: () => void;
  focusEditor: () => void;
  toggleActivity: () => void;
  switchConnection: (profileId: string) => void;
}

type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

export function editorCommandItems(
  ctx: EditorCommandContext,
  actions: EditorCommandActions,
  t: Translate,
): CommandItem[] {
  const items: CommandItem[] = [];

  if (ctx.hasEditor) {
    if (ctx.sessionId) {
      items.push({
        id: "editor:run",
        group: "navigation",
        label: ctx.explainTab ? t("cmdkExplainRun") : t("cmdkRunQuery"),
        icon: ctx.explainTab ? "explain" : "query",
        keywords: "run execute query sql 実行 クエリ",
        shortcut: ctx.shortcuts.run,
        run: () => actions.runAll(),
      });
      if (!ctx.explainTab) {
        items.push({
          id: "editor:run-selected",
          group: "navigation",
          label: t("cmdkRunSelected"),
          icon: "query",
          keywords: "run selected selection statement cursor 選択 実行 カーソル 文",
          shortcut: ctx.shortcuts.runStatement,
          run: () => actions.runStatement(),
        });
        items.push({
          id: "editor:explain",
          group: "navigation",
          label: t("cmdkExplainQuery"),
          icon: "explain",
          keywords: "explain plan query 実行計画 プラン",
          shortcut: ctx.shortcuts.explain,
          run: () => actions.explain(),
        });
      }
    }
    items.push({
      id: "editor:format",
      group: "navigation",
      label: t("cmdkFormatSql"),
      icon: "text",
      keywords: "format beautify pretty sql 整形 フォーマット",
      shortcut: ctx.shortcuts.format,
      run: () => actions.formatSql(),
    });
    items.push({
      id: "editor:focus",
      group: "navigation",
      label: t("cmdkFocusEditor"),
      icon: "query",
      keywords: "focus editor sql エディタ フォーカス",
      run: () => actions.focusEditor(),
    });
  }

  items.push({
    id: "nav:toggle-activity",
    group: "navigation",
    label: t("cmdkToggleActivity"),
    icon: "bell",
    keywords: "activity notifications log bell アクティビティ 通知 履歴 ベル",
    run: () => actions.toggleActivity(),
  });

  for (const conn of ctx.openConnections) {
    if (conn.active) continue;
    items.push({
      id: `switch:${conn.profileId}`,
      group: "connections",
      label: t("cmdkSwitchConnection", { name: conn.name }),
      sublabel: conn.driver.toUpperCase(),
      keywords: `${conn.name} switch connection open 切替 切り替え 接続`,
      icon: "transfer",
      run: () => actions.switchConnection(conn.profileId),
    });
  }

  return items;
}
