import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";
import { CircularReveal } from "./CircularReveal";
import {
  installRevealOriginTracking,
  isHighContrastDataTheme,
  resolveRevealOrigin,
  type RevealPoint,
} from "./revealOrigin";
import type { TitleBarConnection } from "./titleBarContext";
import { accentWashSpec, shouldFireAccentWash } from "./accentWashSpec";

/** 接続は確立まで時間がかかるため、切替の直前に押した位置を少し長めに許す。 */
const ORIGIN_MAX_AGE_MS = 15000;

interface Flash {
  key: number;
  origin: RevealPoint;
  plain: boolean;
  color: string;
  opacity: number;
}

/**
 * 接続切替 (#978) 時の控えめなアクセント/環境ウォッシュ。`ThemeTransition` と
 * 同じポータル方式で、押した位置 (接続リスト) を原点に円状に広がる (#1582。
 * 原点が取れないときは画面中央、reduced-motion では従来のクロスフェード。`CircularReveal`)。新しい接続の環境色 (`titleBarContext` の
 * `connectionBandColor` と同じ優先順位 — 本番接続=危険色、サンドボックス=専用
 * violet、通常接続=プロファイル色 or ワークスペースアクセント。#978 の要件どおり
 * これらの識別性は弱めない) を一瞬重ねてからフェードアウトし、「別の DB に
 * 切り替わった」ことを体感させる誤操作防止の安全キューとして機能する。本番接続
 * への切替は `accentWashOpacity` によりウォッシュをより強くする。
 *
 * `connectionKey` (推奨: セッション id) が**実際に変化し、かつ新しい値が
 * 非 null** のときだけ発火する (`shouldFireAccentWash`) — 同一接続内の
 * 再描画 (自動再接続によるステータス変化など) や切断では発火しない。初回
 * マウント時も `ThemeTransition` と同じ判定で再生しない (`prev` の初期値が
 * 初回の `connectionKey` と一致するため)。`prefers-reduced-motion` はルートの
 * `<MotionConfig reducedMotion="user">` により即時化される (`motion.ts` 参照)。
 * オーバーレイは常に `pointer-events: none` で、操作をブロックしたり入力を
 * 吸ったりしない。
 */
export function AccentWash({
  connectionKey,
  connection,
}: {
  /** 接続の同一性を表すキー。App.tsx はセッション id を渡す。 */
  connectionKey: string | null;
  /** ウォッシュの色/強度を決めるための接続情報。 */
  connection: TitleBarConnection | null | undefined;
}) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const prev = useRef(connectionKey);
  const counter = useRef(0);

  useEffect(() => {
    installRevealOriginTracking();
  }, []);

  useEffect(() => {
    if (!shouldFireAccentWash(prev.current, connectionKey)) {
      prev.current = connectionKey;
      return;
    }
    prev.current = connectionKey;
    const spec = accentWashSpec(connection);
    if (!spec) return;
    counter.current += 1;
    setFlash({
      key: counter.current,
      color: spec.color,
      opacity: spec.opacity,
      plain: isHighContrastDataTheme(document.documentElement.getAttribute("data-theme") ?? ""),
      origin: resolveRevealOrigin(performance.now(), ORIGIN_MAX_AGE_MS, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    });
  }, [connectionKey, connection]);

  return createPortal(
    <AnimatePresence>
      {flash && (
        <CircularReveal
          key={flash.key}
          origin={flash.origin}
          variant="disc"
          plain={flash.plain}
          color={flash.color}
          opacity={flash.opacity}
          onDone={() => setFlash((f) => (f?.key === flash.key ? null : f))}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}
