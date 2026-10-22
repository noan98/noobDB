import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotionConfig } from "motion/react";
import { easings, transitions } from "../motion";
import { shouldGlide, unionBoxes, type BoxRect } from "./selectionGlide";
import { prefersStaticMotion } from "./revealOrigin";

/**
 * `el` のスクロールコンテンツ座標の矩形。`getBoundingClientRect` は祖先の transform
 * (列並べ替え FLIP の translateX・密度変更の scale) を含んでしまい、再生中に測ると枠が
 * ずれたまま残る。レイアウト値の `offset*` を offsetParent チェーンで足し合わせれば
 * transform の影響を受けない。チェーンがスクロールコンテナに届かなければ `null`。
 */
function layoutBox(el: HTMLElement, scroller: HTMLElement): BoxRect | null {
  let left = 0;
  let top = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== scroller) {
    left += cur.offsetLeft;
    top += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  if (cur !== scroller) return null;
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}

export interface GlideFrameOptions {
  /** 絶対配置の枠要素 (`<div hidden>`)。スクロールコンテナ直下に置く。 */
  frameRef: RefObject<HTMLDivElement | null>;
  /** 枠の座標系になるスクロールコンテナ (`position: relative`)。 */
  scrollRef: RefObject<HTMLElement | null> | undefined;
  /** 大きさの変化 (列幅・フォント・ウィンドウ) を拾うために監視する要素 (表)。 */
  observeRef: RefObject<HTMLElement | null>;
  /** 対象の識別子。変わったときだけ滑らせる。`null` なら枠を隠す。 */
  targetKey: string | null;
  /** 描画窓 (仮想化) / 列レイアウトの変化。対象が同じなら滑らせずに追従だけする。 */
  layoutKey: string;
  /** 対象のセル要素 (マウント済みのもの)。対象が変わった / レイアウトが変わったコミットでだけ呼ぶ。 */
  resolve: () => HTMLElement[];
  /** 枠が出ている間 `scrollRef` に立てる data 属性名。CSS が元のセル単位のリングを消すのに使う。 */
  attr: string;
}

/**
 * 結果グリッドの「滑って追従する」枠 (#1578)。アクティブセル / 範囲選択 / 検索ヒットごとに
 * 1 枚の絶対配置オーバーレイを置き、対象が変わった**確定コミットの 1 回だけ**セルの位置を
 * 計測して、前の位置から新しい位置へ Web Animations API で滑らせる。
 *
 * `useColumnReorderFlip` (#1021) / `useRowCrossfade` (#1416) / `useFirstBatchReveal` (#1579) と
 * 同じ流儀の手書き FLIP で、仮想化グリッドの行に Motion の `layout` を常駐させない。
 * 計測するのは「対象が変わった」か「描画窓・列レイアウトが変わった」コミットと、表の
 * ResizeObserver だけ。スクロール中は枠がコンテンツ座標で一緒に動くので計測しない。
 *
 * - 対象が同じままレイアウトだけ変わったとき (スクロールで窓が動いた・列幅変更) は
 *   アニメーションせずその場で追従する。
 * - 滑らせる距離はビューポート 2 枚分まで (`shouldGlide`)。Ctrl+↓ で末尾へ飛ぶような移動は即座に置く。
 * - 滑りの最中に次の移動が来たら、いまの見かけの位置から続きを滑らせる。
 * - 固定 (ピン留め) 列のセルを含む対象は sticky でビューポート座標が変わるため枠を出さず、
 *   元のセル単位のリングに任せる。対象が描画窓の外のときも同様。
 * - reduced-motion (OS / `motionPreference="reduced"`) とハイコントラストは滑らせず即座に置く。
 *   `Element.animate` が無い環境 (jsdom) でも同じ。
 */
export function useGlideFrame(opts: GlideFrameOptions): void {
  const { frameRef, scrollRef, observeRef, targetKey, layoutKey, resolve, attr } = opts;
  const reduced = useReducedMotionConfig();
  const lastSigRef = useRef<string | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const lastBoxRef = useRef<BoxRect | null>(null);
  const animRef = useRef<Animation | null>(null);
  // 最新の入力を ResizeObserver のコールバックから読むための参照。
  const latest = useRef({ targetKey, resolve, reduced });
  latest.current = { targetKey, resolve, reduced };

  const measure = useCallback(
    (animate: boolean) => {
      const frame = frameRef.current;
      const scroller = scrollRef?.current;
      if (!frame || !scroller) return;
      const { targetKey: key, resolve: resolveNow, reduced: isReduced } = latest.current;
      const hide = () => {
        animRef.current?.cancel();
        animRef.current = null;
        frame.hidden = true;
        scroller.removeAttribute(attr);
        lastBoxRef.current = null;
      };
      if (key === null) return hide();
      const els = resolveNow().filter((el) => el.isConnected);
      if (els.length === 0 || els.some((el) => el.classList.contains("is-pinned"))) return hide();
      const boxes: BoxRect[] = [];
      for (const el of els) {
        const b = layoutBox(el, scroller);
        if (!b) return hide();
        boxes.push(b);
      }
      const to = unionBoxes(boxes);
      if (!to) return hide();

      const wasHidden = frame.hidden;
      // 再生中なら見かけの現在位置から続ける (cancel する前に読む)。
      let from = lastBoxRef.current;
      if (animRef.current && !wasHidden) {
        // 枠自身の現在値 (アニメーション途中の left/top/width/height)。
        const cs = getComputedStyle(frame);
        from = {
          left: Number.parseFloat(cs.left) || 0,
          top: Number.parseFloat(cs.top) || 0,
          width: Number.parseFloat(cs.width) || 0,
          height: Number.parseFloat(cs.height) || 0,
        };
      }
      animRef.current?.cancel();
      animRef.current = null;
      frame.hidden = false;
      frame.style.left = `${to.left}px`;
      frame.style.top = `${to.top}px`;
      frame.style.width = `${to.width}px`;
      frame.style.height = `${to.height}px`;
      scroller.setAttribute(attr, "on");
      lastBoxRef.current = to;

      if (isReduced || prefersStaticMotion() || typeof frame.animate !== "function") return;
      const timing: KeyframeAnimationOptions = {
        duration: transitions.emphasized.duration * 1000,
        easing: `cubic-bezier(${easings.out.join(", ")})`,
      };
      let anim: Animation | null = null;
      if (animate && !wasHidden && shouldGlide(from, to, scroller.clientHeight) && from) {
        const px = (b: BoxRect) => ({
          left: `${b.left}px`,
          top: `${b.top}px`,
          width: `${b.width}px`,
          height: `${b.height}px`,
        });
        anim = frame.animate([px(from), px(to)], timing);
      }
      if (anim) {
        const mine = anim;
        animRef.current = mine;
        const done = () => {
          if (animRef.current === mine) animRef.current = null;
        };
        mine.finished?.then(done, done);
      }
    },
    [frameRef, scrollRef, attr],
  );

  // 依存配列なし: 毎コミット走るが、署名が前回と同じなら比較だけで戻る。
  useLayoutEffect(() => {
    const sig = `${targetKey ?? ""}|${layoutKey}`;
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    const changed = targetKey !== lastKeyRef.current;
    lastKeyRef.current = targetKey;
    measure(changed);
  });

  // 表の大きさが変わったとき (列幅ドラッグ・フォント拡大・ウィンドウ) は滑らせずに追従だけ。
  // 表の要素が差し替わったら監視し直すため、毎コミット要素の同一性だけ比べる。
  const roRef = useRef<{ el: Element; ro: ResizeObserver } | null>(null);
  useEffect(() => {
    const el = observeRef.current;
    if (roRef.current?.el === el || typeof ResizeObserver === "undefined") return;
    roRef.current?.ro.disconnect();
    roRef.current = null;
    if (!el) return;
    let first = true;
    const ro = new ResizeObserver(() => {
      // observe 直後の初回通知は無視 (直前のコミットで計測済み)。
      if (first) {
        first = false;
        return;
      }
      if (latest.current.targetKey !== null) measure(false);
    });
    ro.observe(el);
    roRef.current = { el, ro };
  });
  useEffect(
    () => () => {
      roRef.current?.ro.disconnect();
      roRef.current = null;
    },
    [],
  );

  // アンマウント時に後始末する。
  useLayoutEffect(() => {
    const frame = frameRef;
    const scroller = scrollRef;
    return () => {
      animRef.current?.cancel();
      scroller?.current?.removeAttribute(attr);
      if (frame.current) frame.current.hidden = true;
    };
  }, [frameRef, scrollRef, attr]);
}
