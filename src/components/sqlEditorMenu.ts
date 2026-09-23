/**
 * SQL エディタの右クリックメニュー (#1113 / Epic #1110 Phase 3) の純ロジック。
 *
 * 「どの項目を・どの状態で出すか」だけをここで決め、`QueryEditor.tsx` は各
 * アクションを実際のハンドラへ結び付けて共有 `ContextMenu` に渡すだけにする。
 * 副作用なし (DOM / CodeMirror / クリップボードに触れない) なので Vitest で固定できる。
 *
 * 文脈依存のポイント:
 * - **選択の有無**で実行系のラベルを切り替える (「選択範囲を実行」/「クエリを実行」)。
 *   実際に実行されるテキストはツールバーの Run と同じ「選択 → 無ければ全文」。
 * - **カーソル位置の文だけ実行** は選択が無いときに意味を持つ操作なので、選択中は
 *   出さない (選択中の「選択範囲を実行」と同じ結果になり、項目が重複するだけ)。
 * - コピー / 切り取りは選択が無いと何もしないので無効化する (消さずに理由を見せる)。
 * - Dry Run / EXPLAIN / スニペット保存は呼び出し側が機能を渡したときだけ出す
 *   (EXPLAIN タブではエディタの主要アクション自体が EXPLAIN なので出さない)。
 *
 * ショートカット表記は `shortcuts.ts` の id で持ち、呼び出し側が解決済みコンボを
 * `formatCombo` して表示する (ユーザの再割り当て #557 に自動追従)。
 */

import type { I18nKey } from "../i18n";
import type { ShortcutId } from "../shortcuts";
import type { IconName } from "./Icon";

export type SqlEditorMenuAction =
  | "run"
  | "runStatement"
  | "preview"
  | "explain"
  | "format"
  | "toggleComment"
  | "cut"
  | "copy"
  | "selectAll"
  | "saveSnippet";

export interface SqlEditorMenuContext {
  /** エディタに空でない選択範囲があるか。 */
  hasSelection: boolean;
  /** エディタ本文が空白以外を含むか。 */
  hasContent: boolean;
  /** 未接続などでエディタ操作自体が無効か (ツールバーの `disabled` と同じ)。 */
  disabled: boolean;
  /** EXPLAIN タブのエディタか (主要アクションが EXPLAIN になる)。 */
  explainMode: boolean;
  canPreview: boolean;
  canExplain: boolean;
  canSaveSnippet: boolean;
}

export interface SqlEditorMenuItemSpec {
  action: SqlEditorMenuAction;
  labelKey: I18nKey;
  icon?: IconName;
  /** 行末に表示するショートカット (`shortcuts.ts` の再割り当て可能 id)。 */
  shortcutId?: ShortcutId;
  disabled: boolean;
  /** 無効時に理由として出す文言。 */
  disabledReasonKey?: I18nKey;
}

export type SqlEditorMenuEntrySpec = SqlEditorMenuItemSpec | { separator: true };

/** 連続・先頭・末尾のセパレータを取り除く (項目が条件で抜けたときの見た目崩れ防止)。 */
function tidySeparators(entries: SqlEditorMenuEntrySpec[]): SqlEditorMenuEntrySpec[] {
  const out: SqlEditorMenuEntrySpec[] = [];
  for (const e of entries) {
    if ("separator" in e) {
      if (out.length === 0 || "separator" in out[out.length - 1]) continue;
    }
    out.push(e);
  }
  while (out.length > 0 && "separator" in out[out.length - 1]) out.pop();
  return out;
}

export function sqlEditorMenuSpec(ctx: SqlEditorMenuContext): SqlEditorMenuEntrySpec[] {
  const execBlocked = ctx.disabled || !ctx.hasContent;
  const execReason: I18nKey | undefined = ctx.disabled
    ? "editorHintDisabled"
    : !ctx.hasContent
      ? "editorHintEmpty"
      : undefined;
  const entries: SqlEditorMenuEntrySpec[] = [];

  // --- 実行系 (SQL → Execute → Result の導線を先頭に) ---
  entries.push({
    action: "run",
    labelKey: ctx.explainMode
      ? "editorMenuExplainRun"
      : ctx.hasSelection
        ? "editorMenuRunSelection"
        : "editorMenuRunAll",
    icon: ctx.explainMode ? "explain" : "query",
    shortcutId: "run",
    disabled: execBlocked,
    disabledReasonKey: execReason,
  });
  if (!ctx.hasSelection && !ctx.explainMode) {
    entries.push({
      action: "runStatement",
      labelKey: "editorMenuRunStatement",
      shortcutId: "runStatement",
      disabled: execBlocked,
      disabledReasonKey: execReason,
    });
  }
  if (ctx.canPreview && !ctx.explainMode) {
    entries.push({
      action: "preview",
      labelKey: "editorMenuPreview",
      icon: "eye",
      shortcutId: "preview",
      disabled: execBlocked,
      disabledReasonKey: execReason,
    });
  }
  if (ctx.canExplain && !ctx.explainMode) {
    entries.push({
      action: "explain",
      labelKey: "editorMenuExplain",
      icon: "explain",
      shortcutId: "explain",
      disabled: execBlocked,
      disabledReasonKey: execReason,
    });
  }

  // --- 編集系 ---
  entries.push({ separator: true });
  entries.push({
    action: "format",
    labelKey: ctx.hasSelection ? "editorMenuFormatSelection" : "editorMenuFormatAll",
    icon: "text",
    shortcutId: "format",
    // 整形はエディタ内で完結するので未接続でも使える。空文書だけ無効。
    disabled: !ctx.hasContent,
    disabledReasonKey: ctx.hasContent ? undefined : "editorHintEmpty",
  });
  entries.push({
    action: "toggleComment",
    labelKey: "editorMenuToggleComment",
    disabled: false,
  });

  // --- クリップボード ---
  entries.push({ separator: true });
  entries.push({
    action: "cut",
    labelKey: "editorMenuCut",
    disabled: !ctx.hasSelection,
    disabledReasonKey: ctx.hasSelection ? undefined : "editorMenuNeedsSelection",
  });
  entries.push({
    action: "copy",
    labelKey: "editorMenuCopy",
    icon: "copy",
    disabled: !ctx.hasSelection,
    disabledReasonKey: ctx.hasSelection ? undefined : "editorMenuNeedsSelection",
  });
  entries.push({
    action: "selectAll",
    labelKey: "editorMenuSelectAll",
    disabled: !ctx.hasContent,
  });

  if (ctx.canSaveSnippet) {
    entries.push({ separator: true });
    entries.push({
      action: "saveSnippet",
      labelKey: "editorSaveSnippet",
      icon: "snippet",
      disabled: execBlocked,
      disabledReasonKey: execReason,
    });
  }

  return tidySeparators(entries);
}
