// タブごとの SQL 本文の「最新値」置き場 (#1316)。
//
// 以前は打鍵のたびに `setTabs` で `tab.sql` を更新していたため、1 打鍵ごとに App 全体が
// 再レンダーされていた。本文の正本は CodeMirror の `EditorState.doc` に任せ、App は
// 打鍵ごとに「その時点の不変の doc (Text)」への参照だけをここへ置く (O(1)、文字列化しない)。
// 文字列が要るとき (実行・永続化・タブ切替・保存) だけ `get` で `toString()` し、同じ
// doc の間は結果をメモ化する。`tab.sql` は「エディタで一度も編集されていないときの値」に
// 退化するので、本文を読む経路は必ず `resolve` を通すこと。

/** `Text` (CodeMirror の不変ドキュメント) を想定した最小の形。 */
export interface DocLike {
  toString(): string;
}

interface Entry {
  doc: DocLike;
  text: string | null;
}

export class TabSqlStore {
  private readonly entries = new Map<string, Entry>();

  /** 打鍵ごとに呼ぶ。doc への参照を置くだけで、文字列化はしない。 */
  set(tabId: string, doc: DocLike): void {
    const cur = this.entries.get(tabId);
    if (cur && cur.doc === doc) return;
    this.entries.set(tabId, { doc, text: null });
  }

  has(tabId: string): boolean {
    return this.entries.has(tabId);
  }

  /** 最新の本文。エディタで編集されたことが無いタブは undefined。 */
  get(tabId: string): string | undefined {
    const e = this.entries.get(tabId);
    if (!e) return undefined;
    if (e.text === null) e.text = e.doc.toString();
    return e.text;
  }

  /** 最新の本文。編集されていなければ `fallback` (= `tab.sql`)。 */
  resolve(tabId: string, fallback: string): string {
    return this.get(tabId) ?? fallback;
  }

  /** `sql` を最新本文に差し替えたコピー (永続化・複製・保存など、タブ全体を渡す経路用)。 */
  withLatest<T extends { id: string; sql: string }>(tab: T): T {
    const text = this.get(tab.id);
    return text === undefined || text === tab.sql ? tab : { ...tab, sql: text };
  }

  /** `tab.sql` をプログラムから書き換えたとき・タブを閉じたときに捨てる。 */
  delete(tabId: string): void {
    this.entries.delete(tabId);
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * タブの dirty (`本文 !== lastExecutedSql`) 表示を、打鍵ごとの再レンダー無しで保つ。
 *
 * dirty は描画時に最新本文から計算する (`isDirty`)。打鍵のたびに App を再描画する代わりに、
 * 入力が止まって `delayMs` 経ったとき 1 回だけ「いま画面に出している値と変わったか」を
 * 判定し、変わったときだけ `onFlip` で再描画を要求する。連続して打っている間は一切
 * 再描画しない。
 */
export class TabDirtyWatcher {
  private readonly shown = new Map<string, boolean>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly isDirty: (tabId: string) => boolean | undefined,
    private readonly onFlip: () => void,
    private readonly delayMs: number = 150,
  ) {}

  /** 描画した dirty の値を記録する (TabBar へ渡す配列を作るときに呼ぶ)。 */
  recordShown(tabId: string, dirty: boolean): void {
    this.shown.set(tabId, dirty);
  }

  /** 本文が変わった。判定は入力が止まってから 1 回だけ。 */
  noteChange(tabId: string): void {
    const t = this.timers.get(tabId);
    if (t !== undefined) clearTimeout(t);
    this.timers.set(
      tabId,
      setTimeout(() => {
        this.timers.delete(tabId);
        const now = this.isDirty(tabId);
        if (now === undefined) return;
        if (this.shown.get(tabId) !== now) this.onFlip();
      }, this.delayMs),
    );
  }

  forget(tabId: string): void {
    const t = this.timers.get(tabId);
    if (t !== undefined) clearTimeout(t);
    this.timers.delete(tabId);
    this.shown.delete(tabId);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
