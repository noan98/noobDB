import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotionConfig } from "motion/react";
import { durations, easings } from "../motion";
import { columnIdFromCellKey, computeFlipOffsets } from "./columnReorderFlip";

/**
 * 結果グリッドの列ドラッグ並べ替え確定時の FLIP アニメーション (#1021)。
 *
 * 並べ替え前にヘッダの位置を記録 (`capture`) し、新しい列順がコミットされた直後
 * (`useLayoutEffect`、ペイント前) に位置を測り直して、動いた列のセルを元の位置から
 * 新しい位置へ `transform: translateX` だけでスライドさせる。
 *
 * ## Motion の `layout` を使わない理由
 *
 * 見た目は `TabBar` の `layout` と同じ「定位置へ滑る」動きだが、`<th>` に
 * `layout` を付けると Motion は **その要素が再レンダーされるたびに** 位置を計測する。
 * 結果グリッドのヘッダは列仮想化 (#1095/#1099) の対象外で全列ぶん常に描画される
 * うえ、選択・スクロール (行/列ウィンドウの更新) のたびに再レンダーされるため、
 * 数百列で毎回の計測が走り性能を退行させる。また横スクロール位置の変化まで
 * レイアウト変化として拾ってしまう。ここでは **ドロップ確定の 1 回だけ** 計測し、
 * 動いた列だけをアニメーションする。
 *
 * - 位置の計測はヘッダ (`thead th[data-col-id]`) だけで行う。本体・集計フッターの
 *   セルは同じ列なら同じだけ動くので、列 id ごとの差分をそのまま適用する
 *   (セル単位の計測はしない)。本体セルは既存の `cellRefs` (`"行:列"` キー) から引く。
 * - 列仮想化で並べ替え後に新しくマウントされたセルもヘッダ由来の差分で一緒に滑る。
 *   ピン留め列は `getBoundingClientRect` が sticky のずれを含むので、そのまま正しい。
 * - 値は `motion.ts` の `durations.base` / `easings.out` (CSS の `--ease-out` と同じ)。
 * - `prefers-reduced-motion` / アプリ内 `motionPreference="reduced"` (#787) では
 *   `useReducedMotionConfig` (ルートの `MotionConfig` に追従) により計測もしない。
 * - Web Animations API (`fill` なし) なので終了後に inline style を残さない。
 *   `Element.animate` が無い環境 (jsdom) では何もしない。
 */
export function useColumnReorderFlip(
  tableRef: RefObject<HTMLTableElement | null>,
  cellRefs: RefObject<Map<string, HTMLTableCellElement>>,
): { capture: () => void } {
  const reduced = useReducedMotionConfig();
  const pendingRef = useRef<Map<string, number> | null>(null);
  const runningRef = useRef<Animation[]>([]);

  const capture = useCallback(() => {
    const table = tableRef.current;
    if (reduced || !table) {
      pendingRef.current = null;
      return;
    }
    pendingRef.current = measureHeaderLefts(table);
  }, [reduced, tableRef]);

  // 依存配列なし: 毎コミット後に走るが、保留中の計測が無ければ即 return する
  // (ドロップ確定の直後の 1 コミットでだけ実処理が走る)。
  useLayoutEffect(() => {
    const before = pendingRef.current;
    if (!before) return;
    pendingRef.current = null;
    const table = tableRef.current;
    if (!table) return;
    // 連続で並べ替えたときは前回の再生を打ち切ってから新しい位置を測る
    // (再生中の transform が「新しい位置」に混ざらないように)。`before` は
    // 再生途中の見た目の位置なので、そこから滑らかに続きが始まる。
    for (const a of runningRef.current) a.cancel();
    runningRef.current = [];
    const offsets = computeFlipOffsets(before, measureHeaderLefts(table));
    if (offsets.size === 0) return;

    const running: Animation[] = [];
    const timing: KeyframeAnimationOptions = {
      duration: durations.base * 1000,
      easing: `cubic-bezier(${easings.out.join(", ")})`,
    };
    const play = (el: Element, dx: number) => {
      if (typeof (el as HTMLElement).animate !== "function") return;
      running.push(
        el.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], timing),
      );
    };
    // ヘッダと集計フッター (どちらも 1 行)。
    for (const el of Array.from(table.querySelectorAll<HTMLElement>("[data-col-id]"))) {
      const dx = offsets.get(el.dataset.colId ?? "");
      if (dx !== undefined) play(el, dx);
    }
    // 本体 (マウント済みの行 × 列ウィンドウのセルだけ)。
    for (const [key, el] of cellRefs.current) {
      const id = columnIdFromCellKey(key);
      const dx = id === null ? undefined : offsets.get(id);
      if (dx !== undefined && el.isConnected) play(el, dx);
    }
    runningRef.current = running;
  });

  return { capture };
}

function measureHeaderLefts(table: HTMLTableElement): Map<string, number> {
  const out = new Map<string, number>();
  for (const th of Array.from(table.querySelectorAll<HTMLElement>("thead th[data-col-id]"))) {
    const id = th.dataset.colId;
    if (id) out.set(id, th.getBoundingClientRect().left);
  }
  return out;
}
