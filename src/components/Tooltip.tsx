import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type FocusEvent as ReactFocusEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { transitions, variants } from "../motion";
import {
  computeTooltipPosition,
  type TooltipPlacement,
  type TooltipRect,
} from "./tooltipPosition";

export type { TooltipPlacement };

/** `transition` は Chakra 自身のスタイルプロップ名と衝突するため — `ContextMenu` の
 *  `MotionMenu` と同じく — motion へ明示的に forward する必要がある。 */
const MotionBox = chakra(motion.div, {}, { forwardProps: ["transition"] });

/**
 * hover でツールチップが出るまでの既定遅延 (ms)。`Tooltip` と
 * `useDelegatedHover`/`useDelegatedTooltip` が**同じ値**を使う — 出現の速さが
 * 表面ごとに違うと「アプリのどこを触ったか」で挙動が変わるように感じられる。
 * ポインタが目的地へ向かう途中で通過しただけの要素が次々と吹き出しを開く
 * (= マウスを動かすたびに画面がチラつく) のを避けるための間で、OS/ブラウザの
 * native title (約 1 秒) よりは短く、意図して止めたときには待たされたと感じない
 * 程度に短い値を採っている。
 */
export const TOOLTIP_OPEN_DELAY_MS = 400;
const MARGIN_PX = 8;

/**
 * 現在表示中のツールチップを閉じる関数 (アプリ全体で高々 1 つ)。ポインタは 1 つ
 * しかないので、同時に 2 つ以上の吹き出しが見えている状態は常に不本意なもの
 * ——特に**入れ子**にした場合 (一覧の行に行全体のツールチップを付け、その行の
 * 中のアイコン/ボタンにも個別のツールチップを付ける、というのは #884 の置換で
 * 頻出する形) に起きる。React の `onMouseEnter` は行 → 子要素の移動で行側の
 * `onMouseLeave` を発火しないため、内側が開いても外側は開いたままになる。
 * native `title=` は常に最も内側の 1 つだけを表示していたので、その挙動に
 * 合わせて「新しく開いたものが直前のものを閉じる」ようにする。
 */
let activeClose: (() => void) | null = null;

/** 表示を開始する側が呼ぶ。直前に開いていたツールチップがあれば閉じる。 */
function claimTooltip(close: () => void) {
  if (activeClose && activeClose !== close) activeClose();
  activeClose = close;
}

/** 非表示にした側が呼ぶ。自分が現役でなければ何もしない。 */
function releaseTooltip(close: () => void) {
  if (activeClose === close) activeClose = null;
}

/**
 * フォーカスで吹き出しを出してよいのは、キーボードでフォーカスを移したときだけ。
 * クリック (ボタンはクリックでフォーカスを得る) や、モーダルの初期フォーカス・
 * 閉じたあとの戻りフォーカスのようなプログラムからのフォーカスで開くと、
 * ポインタはそこに無いので `mouseleave` が来ず、blur するまで吹き出しが画面に
 * 残り続ける。直前の入力がポインタ操作か「移動キー以外のキー」(ショートカット・
 * Escape・Enter など) なら、フォーカス起因の表示を抑える。
 */
const FOCUS_NAV_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "F6",
  // Shift+Tab の Shift。続く Tab で改めて判定される。
  "Shift",
]);
let focusTooltipSuppressed = false;
let focusIntentInstalled = false;

function installFocusIntentListeners() {
  if (focusIntentInstalled || typeof window === "undefined") return;
  focusIntentInstalled = true;
  window.addEventListener(
    "pointerdown",
    () => {
      focusTooltipSuppressed = true;
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      focusTooltipSuppressed = !FOCUS_NAV_KEYS.has(e.key);
    },
    true,
  );
}

/** ポインタの下の要素が `anchor` の外へ移ったら吹き出しを閉じる安全網。
 *  トリガーが無効化された・再描画で差し替わった・モーダルが上に開いた、などで
 *  `mouseleave` が届かなかった場合でも、次にマウスが動いた時点で閉じる。 */
function isOutsideAnchor(anchor: EventTarget | null, target: EventTarget | null): boolean {
  if (!(anchor instanceof Node) || !anchor.isConnected) return true;
  return !(target instanceof Node && anchor.contains(target));
}

/**
 * `Tooltip` がトリガーに要求する最小限のプロップ表面。実際に使う要素
 * (Chakra の `Button`/`chakra.*`、native タグ) はいずれもこれらを問題なく
 * 受け取れるが、@types/react 19 では `ReactElement` のプロップ型の既定値が
 * `unknown` になったため、`cloneElement` を安全に型付けするためだけにここへ
 * 書き出している。
 */
interface TriggerProps {
  onMouseEnter?: (e: ReactMouseEvent) => void;
  onMouseLeave?: (e: ReactMouseEvent) => void;
  onPointerDown?: (e: ReactPointerEvent) => void;
  onClick?: (e: ReactMouseEvent) => void;
  onFocus?: (e: ReactFocusEvent) => void;
  onBlur?: (e: ReactFocusEvent) => void;
  ref?: Ref<unknown>;
}

export interface TooltipProps {
  /**
   * ツールチップの中身。falsy (`undefined`/`""` を含む) のときは `children` を
   * 一切変更せずそのまま描画する — リスナーも付けず、ポータルも作らない。呼び
   * 出し側は条件付き/派生ラベルを分岐なしでそのまま渡せる (例:
   * `<Tooltip label={disabledReason}>`)。
   */
  label?: ReactNode;
  /**
   * トリガー要素は 1 つだけ。`cloneElement` 経由で hover/focus ハンドラ・マージ
   * 済み ref・`aria-describedby` を受け取るため、DOM ref と任意のプロップを
   * forward できる要素である必要がある — 本コードベース全体で使っている
   * `Button`/`chakra.*`/native タグはいずれも該当する。
   */
  children: ReactElement<TriggerProps>;
  /**
   * 優先する側。はみ出す場合は反対側へフリップしつつビューポート内へクランプ
   * する (`computeTooltipPosition`、`ConnectionList` の `ColumnTooltip` と共有)。
   * 既定は `"top"`。
   */
  placement?: TooltipPlacement;
  /**
   * 出現までの hover 遅延 (ms)。OS の慣習に倣い、ポインタが通り過ぎるだけで
   * チラつかないようにする。フォーカス時は常に即時表示 (遅延なし) — a11y を
   * 優先しており、タブ移動中は「まず hover して発見する」というステップが
   * そもそも無いため、人為的な遅延を入れるとキーボードユーザだけが待たされる
   * ことになる。既定 400。
   */
  openDelay?: number;
  /**
   * トリガーをフォーカス可能な `<span tabIndex={0}>` で包み、トリガー自体が
   * 決してフォーカスを持てない場合でもキーボードユーザがツールチップへ到達
   * できるようにする — 代表例は無効化されたボタンで、ブラウザはタブ順序から
   * 除外するうえ (Chromium では) マウスイベントのディスパッチ自体からも除外
   * する。これが無いと無効なトリガーのツールチップはキーボードで一切到達
   * できない — まさに `ContextMenu` の「なぜこの項目が無効なのか」という
   * #814 が解消しようとしているギャップそのもの。通常の (既にフォーカス/
   * 有効化されている) トリガーではオフのまま (既定) にしておくこと — 無条件で
   * 有効にすると、トリガー自身のタブストップの隣に冗長なタブストップが
   * 増えてしまう。
   */
  focusableWrapper?: boolean;
  /**
   * 吹き出しの最大幅。既定 280px。設定画面のインフォメーションアイコン
   * (`SettingsInfo`) のように段落単位の説明を出すときだけ広げる。
   */
  maxWidth?: string;
  /**
   * クリックでも即座に開く。説明を出すためだけのボタン (設定画面の ⓘ など) 用。
   * 通常のボタンはクリックで吹き出しを閉じる (native title と同じ)。
   */
  openOnClick?: boolean;
}

/**
 * 共有の hover/focus ツールチッププリミティブ (#814)。native `title=` を
 * 置き換える — native title は (1) 表示まで約 1 秒かかる、(2) キーボード
 * フォーカスでは一切表示されない (明確な a11y 欠陥)、(3) アプリのテーマ
 * (ライト/ダーク) に関係なく無地の OS chrome として描画される、(4) ポインタが
 * 少しでも動くと消える、という弱点を持つ。
 *
 * hover (`openDelay` 経過後) またはフォーカス (即時) で出現し、blur / マウス
 * リーブ / Escape / スクロール / リサイズで消える。トリガーには吹き出しを指す
 * `aria-describedby` を付与するので、支援技術はトリガー自身のアクセシブル名と
 * 併せて読み上げる。`<body>` へのポータル経由で描画する点は `ContextMenu` と
 * 同様で、祖先の `overflow: hidden`/スクロールコンテナに切り取られることが
 * ない。位置決めは `computeTooltipPosition` (測定 → クランプ → フリップ) で、
 * `ColumnTooltip` が持つ独自のスキーマ用ホバーカードと同じ計算を使っている。
 *
 * Portal は開くまで作らず (#1319)、閉じても退場アニメーション完了まで残す。Motion (`variants.fadeScale` + `transitions.enter`) は
 * 使う。`ContextMenu` と同じく退出アニメーションは無く、閉じるとバブルは即座に
 * アンマウントされる — これだけ短命な要素では体感できる差にならない。
 * reduced-motion はルートの `MotionConfig` (`motion.ts` 参照) により自動で
 * 効く。
 */
export function Tooltip({
  label,
  children,
  placement = "top",
  openDelay = TOOLTIP_OPEN_DELAY_MS,
  focusableWrapper = false,
  maxWidth = "280px",
  openOnClick = false,
}: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Portal / AnimatePresence を実際に置いているか (#1319)。開いた時点で立て、
  // 退場アニメーションが終わる (`onExitComplete`) まで残す。閉じたまま一度も
  // 開かれていないインスタンスは Portal もファイバーも作らない。
  const [portalMounted, setPortalMounted] = useState(false);
  if (open && !portalMounted) setPortalMounted(true);
  const openRef = useRef(open);
  openRef.current = open;
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShowTimer = () => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  };

  // `claimTooltip`/`releaseTooltip` は関数の同一性で「現役かどうか」を判定する
  // ため、`hide` は初回レンダで 1 つだけ作り以後ずっと同じものを使い回す (ref の
  // 遅延初期化)。中身が触るのは ref と `setOpen` だけなので、クロージャが初回
  // レンダのものでも挙動は変わらない。
  const hideRef = useRef<(() => void) | null>(null);
  if (hideRef.current === null) {
    hideRef.current = () => {
      clearShowTimer();
      releaseTooltip(hideRef.current!);
      setOpen(false);
    };
  }
  const hide = hideRef.current;

  const show = (delay: number) => {
    clearShowTimer();
    // 所有権は**表示予約の時点**で取る。hover 遅延の途中に子トリガーへ入ると
    // 親の `onMouseLeave` は発火しない (React の enter/leave は行 → 子の移動で
    // 親側を呼ばない) ため、`setTimeout` の発火時まで claim を遅らせると、
    // 先に開いた子を親の予約が後から蹴散らして親が表示されてしまう。ここで
    // claim すると子の要求が親の `hide` を呼び、親の予約タイマーも解除される。
    claimTooltip(hide);
    if (delay <= 0) {
      setOpen(true);
      return;
    }
    showTimer.current = setTimeout(() => setOpen(true), delay);
  };

  // キーボード由来のフォーカスでだけ開く。
  const showOnFocus = () => {
    if (!focusTooltipSuppressed) show(0);
  };
  // クリックしたら閉じる (押した結果を吹き出しが覆わないように)。説明専用の
  // ボタンだけはクリックで開く。
  const onTriggerPointerDown = () => hide();
  const onTriggerClick = openOnClick ? () => show(0) : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: clearShowTimer は ref (showTimer) しか触らないのでクロージャが古くても挙動は変わらない。マウント時 1 回だけ登録する
  useEffect(() => {
    installFocusIntentListeners();
    const close = hideRef.current!;
    return () => {
      clearShowTimer();
      releaseTooltip(close);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: hide は ref の遅延初期化で全レンダ同一の関数、中身が触るのは ref と setOpen のみで、open の切替時だけ購読し直せばよい
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onMouseOver = (e: MouseEvent) => {
      if (isOutsideAnchor(anchorRef.current, e.target)) hide();
    };
    window.addEventListener("keydown", onKeyDown);
    // スクロール/リサイズを無視すると、アンカーに追従も連動非表示もされない
    // まま、古い位置に吹き出しが浮いた状態で残ってしまう。
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    // `mouseleave` が届かなかった場合の安全網 (`isOutsideAnchor`)。ウィンドウ
    // 自体からフォーカスが外れた (別アプリへ切り替えた) ときも閉じる。
    document.addEventListener("mouseover", onMouseOver, true);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("mouseover", onMouseOver, true);
      window.removeEventListener("blur", hide);
    };
  }, [open]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: label が変わると吹き出し寸法が変わるため、本体で参照しなくても再計測のトリガーとして依存に含めている
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const anchorRect = anchor.getBoundingClientRect();
    const { width, height } = bubble.getBoundingClientRect();
    setPos(
      computeTooltipPosition(anchorRect, { width, height }, placement, MARGIN_PX, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [open, placement, label]);

  if (!label || !isValidElement(children)) return children ?? null;

  const describedBy = open ? id : undefined;

  const trigger = focusableWrapper ? (
    <Box
      as="span"
      display="inline-block"
      borderRadius="sm"
      ref={anchorRef as Ref<HTMLSpanElement>}
      tabIndex={0}
      onMouseEnter={() => show(openDelay)}
      onMouseLeave={hide}
      onPointerDown={onTriggerPointerDown}
      onClick={onTriggerClick}
      onFocus={showOnFocus}
      onBlur={hide}
      aria-describedby={describedBy}
      _focusVisible={{ outline: "none", boxShadow: "var(--focus-ring)" }}
    >
      {children}
    </Box>
  ) : (
    cloneElement(children, {
      ref: mergeRefs(anchorRef, elementRef(children)),
      onMouseEnter: composeHandler(children.props.onMouseEnter, () => show(openDelay)),
      onMouseLeave: composeHandler(children.props.onMouseLeave, hide),
      onPointerDown: composeHandler(children.props.onPointerDown, onTriggerPointerDown),
      ...(onTriggerClick ? { onClick: composeHandler(children.props.onClick, onTriggerClick) } : {}),
      onFocus: composeHandler(children.props.onFocus, showOnFocus),
      onBlur: composeHandler(children.props.onBlur, hide),
      "aria-describedby": describedBy,
    } as Partial<TriggerProps> & { "aria-describedby"?: string })
  );

  return (
    <>
      {trigger}
      {portalMounted &&
        createPortal(
        <AnimatePresence
          onExitComplete={() => {
            // 退場中に再び開かれた場合は残す (open は閉じている間だけ false)。
            if (!openRef.current) setPortalMounted(false);
          }}
        >
          {open && (
            <MotionBox
              ref={bubbleRef}
              id={id}
              role="tooltip"
              position="fixed"
              zIndex="popover"
              maxWidth={maxWidth}
              bg="app.surface"
              border="1px solid"
              borderColor="app.borderStrong"
              borderRadius="md"
              boxShadow="md"
              py="1"
              px="2.5"
              fontSize="sm"
              color="app.text"
              // native title は改行をそのまま表示していたので、複数行ラベル
              // (`ヒント\n\nSQL` 形式など) が 1 行に潰れないよう pre-wrap で受ける。
              // 最大幅は据え置きなので、長い行は従来どおり折り返す (#884)。
              whiteSpace="pre-wrap"
              pointerEvents="none"
              style={{
                left: `${pos ? pos.left : 0}px`,
                top: `${pos ? pos.top : 0}px`,
                visibility: pos ? "visible" : "hidden",
              }}
              initial={variants.fadeScale.initial}
              animate={variants.fadeScale.animate}
              exit={variants.fadeScale.exit}
              transition={transitions.enter}
            >
              {label}
            </MotionBox>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}

/** React が実行時に `ReactElement` のプロップへ付与する `ref` を読み取る
 *  (公開のプロップ型には含まれない)。これにより、トリガーに既存の ref が
 *  あっても `Tooltip` が測定用に必要とする ref と共存できる。 */
function elementRef(element: ReactElement<TriggerProps>): Ref<unknown> | undefined {
  return (element as unknown as { ref?: Ref<unknown> }).ref;
}

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else (ref as { current: T | null }).current = node;
    }
  };
}

function composeHandler<E extends ReactMouseEvent | ReactFocusEvent | ReactPointerEvent>(
  existing: ((e: E) => void) | undefined,
  extra: (e: E) => void,
): (e: E) => void {
  return (e: E) => {
    existing?.(e);
    extra(e);
  };
}

/**
 * 行/セル単位で大量に描画される一覧 (`ResultGrid` のセル・`ConnectionList`
 * のスキーマツリー行など) 向けの「1 つの共有ツールチップ + イベント委譲」
 * プリミティブ (#884)。`Tooltip` は要素ごとに `cloneElement` でラップするため
 * hover/focus の状態やタイマーも要素数だけ増える — 行/列数が数百〜数千に
 * なりうる一覧でこれを素朴に適用すると、スクロールでの mount/unmount のたびに
 * 多数の Tooltip インスタンスが生成/破棄されるコストが無視できない
 * (#884 の Issue 本文が挙げる性能リスクそのもの)。
 *
 * 対して `useDelegatedTooltip` はマウント中の状態を 1 つだけ持ち、各行/セルは
 * `bind(label)` が返す軽量な `onMouseEnter`/`onMouseLeave` だけを持つ。表示中の
 * バブル自体は `TooltipBubble` (下記) の 1 インスタンスのみで、位置決めは
 * `Tooltip` 本体と同じ `computeTooltipPosition` を再利用する (二重実装しない)。
 *
 * トレードオフ: 個々の要素は `cloneElement` で ref/focus/blur を注入されない
 * ため、`focusableWrapper` のようなキーボード到達手段は無い。呼び出し側の行が
 * 現状すでに `tabIndex` を持たない (キーボード操作対象外の) 一覧でのみ使うこと —
 * キーボードで到達できる行に使う場合は、呼び出し側で別途 `onFocus`/`onBlur` を
 * `bind` の戻り値にマージすること。
 */
export function useDelegatedTooltip(openDelay: number = TOOLTIP_OPEN_DELAY_MS) {
  const { hovered, bind, hide } = useDelegatedHover<string>(openDelay);
  return {
    hovered: hovered && { label: hovered.value, rect: hovered.rect, target: hovered.target },
    bind,
    hide,
  };
}

/** `useDelegatedHover` が表示中に保持する状態。`value` は呼び出し側が
 *  `bind` へ渡したもの (文字列ラベルでも、カラム情報のような構造体でもよい)。 */
export interface DelegatedHoverState<T> {
  value: T;
  /** hover 開始時点でのトリガー要素の矩形 (バブルのアンカー)。 */
  rect: TooltipRect;
  /** どの要素の hover なのか — 離脱判定に使う。 */
  target: EventTarget;
}

/**
 * `useDelegatedTooltip` の一般形。ラベル文字列ではなく任意の値を運べるので、
 * 単純なテキストではない hover カード (`ConnectionList` のカラム詳細など) も
 * **遅延・単一表示の登録簿・スクロール連動非表示**を共有できる。
 *
 * 遅延は `Tooltip` 本体と同じ `TOOLTIP_OPEN_DELAY_MS` が既定で、行やセルの上を
 * ポインタが通過しただけでは開かない。所有権 (`claimTooltip`) は `Tooltip` と
 * 同じく**表示予約の時点**で取る — 遅延の途中で入れ子の内側トリガーへ移った
 * ときに、後から発火した外側の予約が内側を蹴散らさないようにするため。
 */
export function useDelegatedHover<T>(openDelay: number = TOOLTIP_OPEN_DELAY_MS) {
  const [state, setState] = useState<DelegatedHoverState<T> | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 遅延の途中でどの要素の表示を待っているか。離脱した要素が予約の主でなければ
  // 予約は生かす (兄弟の leave → enter が交錯しても取りこぼさない)。
  const pendingTarget = useRef<EventTarget | null>(null);

  const clearShowTimer = () => {
    if (showTimer.current !== null) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    pendingTarget.current = null;
  };

  // 委譲側も `Tooltip` 本体と同じ「同時に見えるのは 1 つ」の登録簿に参加する
  // (行の委譲ツールチップと、その行の中のボタンの `Tooltip` が二重に出ないように)。
  // 登録簿は関数の同一性で現役かどうかを判定するので、`hide` は初回レンダで 1 つ
  // だけ作って以後使い回す。
  const hideRef = useRef<(() => void) | null>(null);
  if (hideRef.current === null) {
    hideRef.current = () => {
      clearShowTimer();
      releaseTooltip(hideRef.current!);
      setState(null);
    };
  }
  const hide = hideRef.current;

  // アンカーはイベント時点の座標スナップショットなので、スクロール/リサイズで
  // 追従できずバブルだけが古い位置に浮いてしまう (`Tooltip` 本体と同じ理由)。
  // 行が再描画で差し替わる・仮想スクロールで外れると `mouseleave` が来ないので、
  // ポインタが表示中の要素の外へ移った時点でも閉じる (`Tooltip` 本体と同じ安全網)。
  // クリックしたときも閉じる。
  useEffect(() => {
    if (!state) return;
    const close = hideRef.current!;
    const onMouseOver = (e: MouseEvent) => {
      if (isOutsideAnchor(state.target, e.target)) close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("pointerdown", close, true);
    document.addEventListener("mouseover", onMouseOver, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("pointerdown", close, true);
      document.removeEventListener("mouseover", onMouseOver, true);
    };
  }, [state]);

  useEffect(() => {
    const close = hideRef.current!;
    return () => {
      if (showTimer.current !== null) clearTimeout(showTimer.current);
      releaseTooltip(close);
    };
  }, []);

  const bind = (value: T | undefined | null) => {
    if (value === undefined || value === null || value === "") return undefined;
    return {
      onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => {
        const target = e.currentTarget;
        // 矩形は**この時点**で採る。React のイベントは非同期に持ち越せず
        // (`currentTarget` はハンドラを抜けると null になる)、遅延後に測り直す
        // 理由も無い (レイアウトが動いたならスクロール連動で閉じる)。
        const next: DelegatedHoverState<T> = { value, rect: target.getBoundingClientRect(), target };
        clearShowTimer();
        claimTooltip(hide);
        if (openDelay <= 0) {
          setState(next);
          return;
        }
        pendingTarget.current = target;
        showTimer.current = setTimeout(() => {
          showTimer.current = null;
          pendingTarget.current = null;
          setState(next);
        }, openDelay);
      },
      onMouseLeave: (e: ReactMouseEvent<HTMLElement>) => {
        if (pendingTarget.current === e.currentTarget) clearShowTimer();
        releaseTooltip(hide);
        setState((cur) => (cur?.target === e.currentTarget ? null : cur));
      },
    };
  };

  return { hovered: state, bind, hide };
}

/**
 * `useDelegatedTooltip` が管理する単一の共有バブル本体。`Tooltip` 本体の
 * バブルと見た目・位置決め (`computeTooltipPosition`) を共有する、Portal 経由の
 * 表示専用コンポーネント。
 */
export function TooltipBubble({
  label,
  anchor,
  placement = "top",
  maxWidth = "280px",
}: {
  label: ReactNode;
  anchor: TooltipRect;
  placement?: TooltipPlacement;
  maxWidth?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: label が変わると吹き出し寸法が変わるため、本体で参照しなくても再計測のトリガーとして依存に含めている
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const size = el.getBoundingClientRect();
    setPos(
      computeTooltipPosition(anchor, size, placement, MARGIN_PX, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [label, anchor, placement]);

  return createPortal(
    <Box
      ref={ref}
      role="tooltip"
      position="fixed"
      zIndex="popover"
      maxWidth={maxWidth}
      bg="app.surface"
      border="1px solid"
      borderColor="app.borderStrong"
      borderRadius="md"
      boxShadow="md"
      py="1"
      px="2.5"
      fontSize="sm"
      color="app.text"
      whiteSpace="pre-wrap"
      pointerEvents="none"
      style={{
        left: `${pos ? pos.left : anchor.left}px`,
        top: `${pos ? pos.top : anchor.top}px`,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {label}
    </Box>,
    document.body,
  );
}
