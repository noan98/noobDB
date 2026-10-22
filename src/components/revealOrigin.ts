/**
 * 円形リビール (#1582) の原点決定ロジック。`ThemeTransition` / `AccentWash` の
 * 副作用 (portal 描画・アニメーション) から分離した純関数 + 最後の操作トラッカー。
 *
 * 切替のトリガー (テーマトグル / 接続リスト) は呼び出し側コンポーネントから遠い
 * ので、props で座標を引き回さず、`pointerdown` の座標を window で拾っておき、
 * オーバーレイ発火時に「直近のポインタ操作か」を判定して原点に使う。キーボード
 * (ショートカット / コマンドパレット / Enter) 経由では原点が取れないため、画面中央へ
 * フォールバックする。
 */

export interface RevealPoint {
  x: number;
  y: number;
}

interface LastInteraction {
  point: RevealPoint;
  at: number;
}

let lastPointer: LastInteraction | null = null;
/** 最後のキー操作の時刻。ポインタ操作より新しければ原点を信用しない。 */
let lastKeyAt = 0;
let installed = false;

/** ポインタ操作の座標を記録する (テスト用に公開)。 */
export function recordPointer(point: RevealPoint, at: number): void {
  lastPointer = { point, at };
}

/** キー操作を記録する (テスト用に公開)。 */
export function recordKey(at: number): void {
  lastKeyAt = at;
}

/** テスト用: トラッカーの状態を初期化する。 */
export function resetRevealOrigin(): void {
  lastPointer = null;
  lastKeyAt = 0;
}

/**
 * window に `pointerdown` / `keydown` の記録リスナーを一度だけ付ける。capture 相で
 * 拾うので、子が stopPropagation しても座標は取れる。
 */
export function installRevealOriginTracking(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "pointerdown",
    (e) => recordPointer({ x: e.clientX, y: e.clientY }, performance.now()),
    {
      capture: true,
      passive: true,
    },
  );
  window.addEventListener("keydown", () => recordKey(performance.now()), { capture: true, passive: true });
}

/**
 * 原点を決める。直近のポインタ操作が `maxAgeMs` 以内で、かつその後にキー操作が
 * 無ければその座標、そうでなければ画面中央。`now` は `performance.now()` (リスナーも同じ
 * 時計で記録する)。
 */
export function resolveRevealOrigin(
  now: number,
  maxAgeMs: number,
  viewport: { width: number; height: number },
): RevealPoint {
  const center = { x: viewport.width / 2, y: viewport.height / 2 };
  if (!lastPointer) return center;
  if (now - lastPointer.at > maxAgeMs) return center;
  if (lastKeyAt > lastPointer.at) return center;
  return lastPointer.point;
}

/** 原点から最も遠い角までの距離。この半径の円で画面全体を覆える。 */
export function revealRadius(origin: RevealPoint, viewport: { width: number; height: number }): number {
  const dx = Math.max(origin.x, viewport.width - origin.x);
  const dy = Math.max(origin.y, viewport.height - origin.y);
  return Math.ceil(Math.hypot(dx, dy));
}

/** `clip-path: circle()` の値。 */
export function revealClipPath(origin: RevealPoint, radius: number): string {
  return `circle(${Math.round(radius)}px at ${Math.round(origin.x)}px ${Math.round(origin.y)}px)`;
}

/** 高コントラストテーマ (hc-light / hc-dark) では装飾を抑えるため円形リビールを使わない。 */
export function isHighContrastDataTheme(dataTheme: string): boolean {
  return dataTheme.startsWith("hc-");
}

/** ハイコントラスト (テーマ hc-* / forced-colors) か。装飾的な動きは出さない。 */
export function prefersStaticMotion(): boolean {
  if (typeof document === "undefined") return false;
  if (isHighContrastDataTheme(document.documentElement.getAttribute("data-theme") ?? "")) return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(forced-colors: active)").matches;
}
