/**
 * 結果グリッド・スキーマツリーの行でコンテキストメニューをキーボードから開くための
 * 共通判定 (#1185)。副作用なしの純関数として切り出し、`ResultGrid` / `ConnectionList`
 * の両方から同じ判定を共有する (`modalKeys.ts` と同じ方針)。
 *
 * 対応するキーは 2 つ:
 * - **Shift+F10** — Windows で右クリックメニューを開く伝統的なキー
 * - **`ContextMenu` キー** (フルサイズキーボードのメニューキー)
 *
 * どちらも右クリックと同じ位置 (アクティブな行/セルの左下) にメニューを開く。
 * 座標は要素の `getBoundingClientRect()` から `contextMenuPointFromRect` で
 * 求め、右クリックの `e.clientX`/`e.clientY` と同じ形の値として
 * 既存の `ContextMenu` / `computeMenuPosition` (`menuPosition.ts`) へそのまま渡せる。
 */

/** 判定に要る、キーボードイベントの最小限の形。 */
export interface ContextMenuOpenKeyEventLike {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/**
 * React のキーボードイベントから判定に要る値だけを抜き出す。IME 変換中かどうかは
 * 合成イベントに無く `nativeEvent.isComposing` にしか無いため、ここで拾う
 * (`modalKeys.ts` の `pickModalKeys` と同じ理由)。
 */
export function pickContextMenuOpenKeys(e: {
  key: string;
  shiftKey: boolean;
  defaultPrevented: boolean;
  nativeEvent: { isComposing?: boolean };
}): ContextMenuOpenKeyEventLike {
  return {
    key: e.key,
    shiftKey: e.shiftKey,
    isComposing: e.nativeEvent.isComposing,
    defaultPrevented: e.defaultPrevented,
  };
}

/**
 * コンテキストメニューをキーボードから開くキー (Shift+F10 / `ContextMenu` キー) か。
 * IME 変換中や、既に別のハンドラが処理済み (`defaultPrevented`) のキーは無視する。
 */
export function isContextMenuOpenKey(e: ContextMenuOpenKeyEventLike): boolean {
  if (e.isComposing) return false;
  if (e.defaultPrevented) return false;
  if (e.key === "ContextMenu") return true;
  return e.key === "F10" && e.shiftKey;
}

/** `getBoundingClientRect()` のうち、メニュー起点の算出に使う部分。 */
export interface ContextMenuAnchorRect {
  left: number;
  bottom: number;
}

/**
 * 要素の矩形から、右クリックの `clientX`/`clientY` に相当するメニューの起点を
 * 求める。左下 (行/セルのすぐ下) を起点にする — 右クリックの「クリックした点」に
 * 最も近い、要素に重ならない位置。
 */
export function contextMenuPointFromRect(rect: ContextMenuAnchorRect): { x: number; y: number } {
  return { x: rect.left, y: rect.bottom };
}

/**
 * 右クリックの `onContextMenu` ハンドラが実際に使う最小限のイベント形。
 * `React.MouseEvent` はこれを構造的に満たすため、既存の右クリックハンドラの
 * 引数型をこれに緩めるだけで、キーボード起動からも同じ関数をそのまま呼べる
 * (右クリックのメニュー組み立てロジックを二重に書かない)。
 */
export interface ContextMenuTriggerEvent {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/**
 * 要素の矩形から `ContextMenuTriggerEvent` を組み立てる。キーボードで開いた
 * ときは実際のマウスイベントが無いため、`preventDefault`/`stopPropagation` は
 * 何もしないダミーにする (呼び出し元の keydown ハンドラ側で既に処理済み)。
 */
export function contextMenuTriggerFromRect(rect: ContextMenuAnchorRect): ContextMenuTriggerEvent {
  const { x, y } = contextMenuPointFromRect(rect);
  return {
    clientX: x,
    clientY: y,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}
