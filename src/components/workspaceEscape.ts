/**
 * 全画面サーフェスとレイアウト最大化の Escape 解決 (#1070)。
 *
 * メイン領域の Escape には「誰が受け取るか」の候補が複数ある:
 *
 * 1. ネストしたレイヤ (Modal / ContextMenu / 列フィルタ等のポップオーバー /
 *    コンボボックスのリスト) — 自分自身だけを閉じる。**最優先**。
 * 2. 入力欄 / エディタ — 検索クリア等のローカル Esc 処理を奪わない。
 * 3. 全画面サーフェス (ER 図・スキーマ比較・ユーザ管理・Server Info・テーブル統計・
 *    結果比較) — `onClose` を呼んでワークスペースへ戻る。
 * 4. レイアウト最大化 (結果最大化 / エディタ集中) — 通常表示へ戻す。これは
 *    **通常ワークスペースが見えているときだけ**。全画面サーフェスの下に隠れた
 *    最大化状態を、見えないまま解除してしまわないため。
 *
 * どちらのハンドラ (`WorkspaceSurface` と `App.tsx` のレイアウト Escape) も window
 * の keydown を購読しており、リスナの登録順は再レンダリングで入れ替わるため
 * 「先に処理した側が `preventDefault` する」方式では排他にできない。そこで両者が
 * 同じ入力からこの純関数を引き、**自分の担当アクションのときだけ動く**ことで、
 * 1 回の Escape が 2 つの操作を同時に起こさないようにしている。
 *
 * 接続フォーム / スニペットフォーム (`"form"` / `"snippetForm"`) は全画面サーフェス
 * だが Escape では閉じない。未保存の入力を 1 キーで破棄させないため (既存の
 * キャンセルボタンが唯一の導線)。
 */
import type { WorkspaceViewKey } from "./workspaceView";

/** Escape で閉じる全画面サーフェス。フォーム系は意図的に含めない (上記)。 */
const ESCAPE_CLOSABLE_VIEWS: ReadonlySet<WorkspaceViewKey> = new Set<WorkspaceViewKey>([
  "compare",
  "erd",
  "users",
  "serverInfo",
  "sizes",
  "compareResults",
]);

/** そのサーフェスが Escape で閉じる対象か。 */
export function isEscapeClosableView(view: WorkspaceViewKey): boolean {
  return ESCAPE_CLOSABLE_VIEWS.has(view);
}

/** `resolveWorkspaceEscape` の入力。DOM 依存の判定は呼び出し側で済ませて渡す。 */
export type WorkspaceEscapeInput = {
  /** `KeyboardEvent.key`。 */
  key: string;
  /** 既に誰かが処理済み (ContextMenu のパネル・ComboSelect 等が立てる)。 */
  defaultPrevented: boolean;
  /** IME 変換中の Escape は変換の取り消しであって、画面を閉じる操作ではない。 */
  isComposing: boolean;
  /** Modal / メニュー / ポップオーバーが開いている (`hasOpenNestedLayer`)。 */
  nestedLayerOpen: boolean;
  /** 入力欄 / エディタにフォーカスがある (`isEditableElement`)。 */
  editableFocused: boolean;
  /** 現在の全画面サーフェス (`workspaceViewKey`)。 */
  view: WorkspaceViewKey;
  /** レイアウトが最大化 / エディタ集中中か (`layoutMode !== "normal"`)。 */
  layoutMaximized: boolean;
};

/** Escape で起こすアクション。`null` は「メイン領域では何もしない」。 */
export type WorkspaceEscapeAction = "closeView" | "restoreLayout" | null;

/** Escape を誰が処理するかを 1 つに決める (優先順位は冒頭のコメント)。 */
export function resolveWorkspaceEscape(input: WorkspaceEscapeInput): WorkspaceEscapeAction {
  if (input.key !== "Escape") return null;
  if (input.defaultPrevented || input.isComposing) return null;
  if (input.nestedLayerOpen) return null;
  if (input.editableFocused) return null;
  if (isEscapeClosableView(input.view)) return "closeView";
  if (input.view === "workspace" && input.layoutMaximized) return "restoreLayout";
  return null;
}

/**
 * 「自分だけを閉じる」ネストしたレイヤの role。Modal (Chakra Dialog) は
 * `role="dialog"`、ContextMenu / タブメニューは `role="menu"`、結果グリッドの列
 * フィルタ・統計ポップオーバーは `role="dialog"`、ComboSelect の候補は
 * `role="listbox"`。いずれも開いている間だけマウントされる (ポータル)。
 */
const NESTED_LAYER_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * 文書内に開いたネストレイヤがあるか。`hidden` / `aria-hidden="true"` の配下は
 * 閉じたまま残っている DOM とみなして数えない。
 *
 * イベントの発生元ではなく文書全体を見るのは、ContextMenu がフォーカス外でも
 * window の Escape で閉じる (= フォーカスがサーフェス側に残ったまま閉じる) ため。
 */
export function hasOpenNestedLayer(root: ParentNode): boolean {
  const layers = root.querySelectorAll(NESTED_LAYER_SELECTOR);
  for (const el of Array.from(layers)) {
    if (el.closest('[hidden], [aria-hidden="true"]')) continue;
    return true;
  }
  return false;
}

/** 入力欄 / エディタ (ローカルな Escape 処理を持ちうる要素) か。 */
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  // jsdom は `isContentEditable` を実装しないため属性でも判定する。
  return el.closest('.cm-editor, [contenteditable=""], [contenteditable="true"]') !== null;
}

/**
 * サーフェスのアクセシブルネームに使う i18n キー。各ビューの見出しと同じ文言。
 * フォーム系は `WorkspaceSurface` で包まないため持たない。
 */
export const WORKSPACE_SURFACE_LABEL_KEYS = {
  compare: "schemaCompareTitle",
  erd: "erDiagramTitle",
  users: "usersTitle",
  serverInfo: "serverInfoTitle",
  sizes: "sizeTitle",
  compareResults: "pinCompareTitle",
} as const;

/** `WorkspaceSurface` で包む (= Escape で閉じる) サーフェスの識別子。 */
export type ClosableWorkspaceView = keyof typeof WORKSPACE_SURFACE_LABEL_KEYS;
