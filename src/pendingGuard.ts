// 結果を置き換える手動操作に入る前の「未適用の変更」ガード (#2234) の純ロジック。
//
// 同じタブの結果を置き換える操作 (ページ送り・ソート・フィルタ・再実行・TX 内実行) は、
// セル編集 (pendingEdits) と Undo / Redo 履歴を捨てる。以前は確認が無く、削除予定・追加行だけが
// 無言で残って別ページの行に対する DELETE が Apply で走りえた。入口で判定し、未適用の変更が
// あれば「適用して続行 / 破棄して続行 / キャンセル」を選ばせる。
// 切断・タブを閉じる (#1391) は `tabDirty.ts` の `closeGuard`。ここは同じタブ内の置き換え用。
// 確認を出すかの判定はここに集め、App は結果 (`ReplaceGuard`) に従って確認・適用・破棄する。
// #2235 の変更セットバーも `pendingChangeCounts` を件数の単一ソースとして再利用する。

import { countEditedRows, type PendingEdits } from "./components/cellEdit";
import { hasPendingChanges, type DirtyTabLike } from "./tabDirty";

/** 結果を置き換える操作の経路。確認文言の「何をしようとしたか」に使う。 */
export type ReplaceRoute =
  /** SQL の実行・再実行 (EXPLAIN・制限解除の再実行を含む)。 */
  | "run"
  /** 明示トランザクション内の実行。 */
  | "tx"
  /** ページ送り (ボタン・Alt+←→・ページ番号へのジャンプ)。 */
  | "page"
  /** ページサイズの変更。 */
  | "pageSize"
  /** 列ヘッダからのサーバ側ソート。 */
  | "sort"
  /** サーバ側フィルタ。 */
  | "filter";

/** `goToPageInTab` の引数から経路を決める (ソート/フィルタの適用・解除はページ番号が変わらなくても置き換える)。 */
export function routeOfPageNav(
  sizeOverride: number | undefined,
  browse: { sort?: unknown; filter?: unknown } | undefined,
): ReplaceRoute {
  if (browse && "sort" in browse) return "sort";
  if (browse && "filter" in browse) return "filter";
  if (sizeOverride !== undefined) return "pageSize";
  return "page";
}

/** 未適用の変更の内訳 (確認文言の件数)。 */
export interface PendingChangeCounts {
  /** 編集中のセル数 (空の行エントリは数えない)。 */
  edits: number;
  /** セル編集のある行数 (UPDATE の対象行)。 */
  editedRows: number;
  deletes: number;
  inserts: number;
}

export function pendingChangeCounts(
  tab: Pick<DirtyTabLike, "pendingEdits" | "pendingDeletes" | "pendingInserts">,
): PendingChangeCounts {
  let edits = 0;
  for (const row of Object.values(tab.pendingEdits ?? {})) edits += Object.keys(row).length;
  return {
    edits,
    editedRows: countEditedRows(tab.pendingEdits ?? {}),
    deletes: tab.pendingDeletes?.length ?? 0,
    inserts: tab.pendingInserts?.length ?? 0,
  };
}

/** 入口での判定結果。 */
export type ReplaceGuard =
  /** そのまま続行してよい。 */
  | { kind: "proceed" }
  /** Apply 実行中。二重 Apply になるので操作を保留する。 */
  | { kind: "applying" }
  /** 未適用の変更がある。3 択の確認が要る。 */
  | { kind: "confirm"; counts: PendingChangeCounts };

export interface ReplaceGuardInput {
  /** 判定対象のタブ。見つからない / 結果を置き換えない場合は呼び出し側で `proceed` 扱いにする。 */
  tab: (DirtyTabLike & { applyingEdits?: boolean }) | null | undefined;
  /** 自動リフレッシュ (未適用の変更があれば呼び出し前に見送る別経路) や、確認済みの再入では true。 */
  skip?: boolean;
}

/**
 * 結果を置き換える操作の入口で確認が要るかを返す。経路 (`ReplaceRoute`) によらず、
 * セル編集・削除予定・追加行のどれが残っていても同じ扱い (これまで経路ごとに食い違っていた)。
 */
export function decideReplaceGuard(input: ReplaceGuardInput): ReplaceGuard {
  const { tab, skip } = input;
  if (skip || !tab) return { kind: "proceed" };
  if (!hasPendingChanges(tab)) return { kind: "proceed" };
  if (tab.applyingEdits) return { kind: "applying" };
  return { kind: "confirm", counts: pendingChangeCounts(tab) };
}

/**
 * 「破棄して続行」で Undo 履歴へ積むセル編集。空なら積まない (`null`)。
 * `discardEditsAndPreviewForTab` と同じく、直前の編集 1 世代をスタックの末尾に載せる。
 */
export function discardedEditsForUndo(pendingEdits: PendingEdits): PendingEdits | null {
  for (const row of Object.values(pendingEdits ?? {})) {
    if (Object.keys(row).length > 0) return pendingEdits;
  }
  return null;
}

/**
 * 変更セットを適用するときに送る文の内訳。「UPDATE 3 / INSERT 1 / DELETE 2」の形 (0 件の種類は省く)。
 * 件数は行単位 (UPDATE は編集した行数)。適用ボタンのツールチップ・確認文で、実際に送る文の種類と
 * 件数をラベルと一致させるために使う (#2235)。
 */
export function changeSetStatementText(
  counts: Pick<PendingChangeCounts, "editedRows" | "inserts" | "deletes">,
): string {
  const parts: string[] = [];
  if (counts.editedRows > 0) parts.push(`UPDATE ${counts.editedRows}`);
  if (counts.inserts > 0) parts.push(`INSERT ${counts.inserts}`);
  if (counts.deletes > 0) parts.push(`DELETE ${counts.deletes}`);
  return parts.join(" / ");
}
