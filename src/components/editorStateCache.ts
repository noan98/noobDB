// SQL エディタ (CodeMirror) のタブ別 EditorState キャッシュ (#1308)。
//
// タブを切り替えるたびに `EditorView` を作り直す代わりに、ペインごとに 1 つの view を
// 保ち、タブごとの `EditorState` を保存・復元して `view.setState` で差し替える。
// undo 履歴・選択・検索パネルなどは state が持つので、切り替えて戻っても保たれる。
//
// 保持数には上限を設ける (Epic #1306 の keep-alive 方針)。上限を超えたら最も長く
// 使われていないタブから捨てる (捨てられたタブは次回 `initialSql` から作り直し、
// undo 履歴だけが失われる)。純ロジックにして Vitest で検証できるようにしている。

import type { EditorState } from "@codemirror/state";

/** 保持するタブ別 state の上限。通常の作業で開くタブ数より十分大きく、メモリは抑える。 */
export const EDITOR_STATE_CACHE_LIMIT = 24;

/** state を作った (または最後に再構成した) 時点で compartment に入っている設定のキー。 */
export interface AppliedEditorConfig {
  driver: string;
  schemaKey: string;
  /** 親が保持する安定参照。参照が変わったときだけ補完を作り直す。 */
  databaseSchema: unknown;
  defaultDatabase: string | null;
  /** 構文チェックのオン/オフと診断メッセージを連結したキー。 */
  lint: string;
  /** 再割り当て可能なアクションのコンボを連結したキー。 */
  keymap: string;
}

export interface CachedEditorState {
  state: EditorState;
  applied: AppliedEditorConfig;
  /** `.cm-scroller` / ホスト要素のスクロール位置。 */
  scrollTop: number;
  hostScrollTop: number;
}

/** 補完 (SQL 拡張) の構成が変わったか。 */
export function sqlConfigChanged(a: AppliedEditorConfig, b: AppliedEditorConfig): boolean {
  return (
    a.driver !== b.driver ||
    a.schemaKey !== b.schemaKey ||
    a.databaseSchema !== b.databaseSchema ||
    a.defaultDatabase !== b.defaultDatabase
  );
}

/** 挿入順 = 最近使った順の LRU。`Map` の列挙順を利用する。 */
export class EditorStateCache {
  private readonly map = new Map<string, CachedEditorState>();

  constructor(private readonly limit: number = EDITOR_STATE_CACHE_LIMIT) {}

  get size(): number {
    return this.map.size;
  }

  has(tabId: string): boolean {
    return this.map.has(tabId);
  }

  /** 保存する。上限を超えたら最も古いものを捨てる。 */
  set(tabId: string, entry: CachedEditorState): void {
    this.map.delete(tabId);
    this.map.set(tabId, entry);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** 取り出して削除する (アクティブなタブの state は view 自身が持つため)。 */
  take(tabId: string): CachedEditorState | undefined {
    const entry = this.map.get(tabId);
    this.map.delete(tabId);
    return entry;
  }
}
