import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { motion } from "motion/react";
import { transitions, variants } from "../motion";
import { touchKeepAlive } from "./keepAliveSet";

/**
 * 一度開いた中身を、非アクティブの間も破棄せず `hidden` で保持する器 (#1311)。
 *
 * サイドバー / ボトムパネルのタブや全画面サーフェスを `AnimatePresence mode="wait"` +
 * `key` で切り替えると、離れた側がアンマウントされ、戻るたびに初期化と IPC をやり直す
 * (ツリーの再取得、インスペクタの記録消失など)。ここでは遅延マウント + keep-alive にする。
 *
 * ## 使い方
 *
 * `children` には**アクティブなキーの中身だけ**を渡す。非アクティブなキーは最後に
 * 渡された要素をそのまま再利用する (同じ参照なので React が再描画を省く)。したがって
 * 非表示の間は親の再レンダーの影響を受けず、再表示した最初のレンダーで最新の props が入る。
 * 常に最新の props が要る中身 (`ConnectionList` など) はこの器に載せず、呼び出し側で
 * 別に常駐させる。
 *
 * ## 保持数の上限
 *
 * `limit` を超えたら最も長く使われていないものから捨てる (`touchKeepAlive`)。キーの
 * 集合が有限で小さい呼び出し側 (サイドバーの 4 タブ・ボトムパネルのタブ) は、全キー数を
 * `limit` に渡す (= 事実上の上限は元からキー数)。
 *
 * ## 非アクティブの間
 *
 * - `hidden` + `inert` + `display:none` で、フォーカス・タブ順・スクリーンリーダー・
 *   レイアウト計算から外す。
 * - 中身は `useKeepAliveActive()` で非アクティブを知り、ポーリングを止める。
 *   マウントは続くので、記録のような**中身自身の state は消えない**。
 * - `resetKey` が変わったら (接続の切替など) 保持している中身をすべて捨てる。古い
 *   セッションを指したまま残らないようにするため。
 *
 * ## モーション
 *
 * 退場アニメーションは持たない (`mode="wait"` の待ち時間をなくすため)。再表示のとき
 * だけ `variants.fade` で入場する。reduced-motion はルートの `MotionConfig` が抑制する。
 */

const ActiveContext = createContext(true);

/**
 * keep-alive 配下の中身が「今見えているか」。器の外では常に true。
 * ポーリングする中身は false の間 interval を止める。
 */
export function useKeepAliveActive(): boolean {
  return useContext(ActiveContext);
}

/**
 * 非アクティブ → アクティブに戻った瞬間に `refresh` を 1 度呼ぶ。ポーリングを止めて
 * いた間に古くなった表示を、次の interval を待たずに更新するため。初回マウントでは呼ばない
 * (各パネルが自前で初回ロードする)。
 */
export function useRefreshOnReactivate(active: boolean, refresh: () => unknown): void {
  const prev = useRef(active);
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (active && !prev.current) void latest.current();
    prev.current = active;
  }, [active]);
}

const ITEM_BASE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  flexDirection: "column",
  overflow: "hidden",
};

export interface KeepAliveProps {
  /** 今見せるキー。null なら全部を隠す (保持は続ける)。 */
  activeKey: string | null;
  /** アクティブなキーの中身。 */
  children: ReactNode;
  /** 保持するキーの上限。 */
  limit: number;
  /** 変わったら保持をすべて捨てる。 */
  resetKey?: string | null;
  /** ルート要素の追加スタイル (重ねて置くときの `position: absolute` など)。 */
  rootStyle?: CSSProperties;
  /** 各アイテムの追加スタイル。 */
  itemStyle?: CSSProperties;
}

export function KeepAlive({
  activeKey,
  children,
  limit,
  resetKey = null,
  rootStyle,
  itemStyle,
}: KeepAliveProps) {
  const [state, setState] = useState<{
    reset: string | null;
    /** reset のたびに増やし、同じキーでも別インスタンスとして作り直させる。 */
    gen: number;
    keys: readonly string[];
  }>({ reset: resetKey, gen: 0, keys: [] });
  const cache = useRef(new Map<string, ReactNode>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  const resetting = state.reset !== resetKey;
  const gen = resetting ? state.gen + 1 : state.gen;
  if (resetting) cache.current.clear();
  const nextKeys = touchKeepAlive(resetting ? [] : state.keys, activeKey, limit);
  if (resetting || nextKeys !== state.keys) {
    setState({ reset: resetKey, gen, keys: nextKeys });
  }
  const keys = nextKeys;

  // 描画中のキャッシュ更新 (同じ入力なら同じ結果になる冪等な操作)。
  if (activeKey !== null) cache.current.set(activeKey, children);
  for (const k of [...cache.current.keys()]) if (!keys.includes(k)) cache.current.delete(k);

  // キーを安定した順で描く: 最近使った順で並べ替えると React が DOM を移動させ、
  // フォーカスや iframe の状態を壊しうる。
  const ordered = [...keys].sort();
  return (
    <div
      style={{
        display: activeKey === null ? "none" : "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        ...rootStyle,
      }}
      hidden={activeKey === null}
    >
      {ordered.map((k) => (
        <KeepAliveItem
          key={`${gen}:${k}`}
          active={k === activeKey}
          animateIn={mounted.current}
          style={itemStyle}
        >
          {cache.current.get(k)}
        </KeepAliveItem>
      ))}
    </div>
  );
}

function KeepAliveItem({
  active,
  animateIn,
  style,
  children,
}: {
  active: boolean;
  /** 器のマウント後に増えたアイテムだけ入場のフェードを付ける (初回表示は即時)。 */
  animateIn: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <ActiveContext.Provider value={active}>
      <motion.div
        hidden={!active}
        inert={!active || undefined}
        data-keep-alive-active={active}
        initial={animateIn ? variants.fade.initial : false}
        animate={active ? variants.fade.animate : variants.fade.initial}
        transition={transitions.crossfade}
        style={{ ...ITEM_BASE, ...style, display: active ? "flex" : "none" }}
      >
        {children}
      </motion.div>
    </ActiveContext.Provider>
  );
}
