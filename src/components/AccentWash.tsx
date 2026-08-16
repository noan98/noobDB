import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { transitions } from "../motion";
import type { TitleBarConnection } from "./titleBarContext";
import { accentWashSpec, shouldFireAccentWash } from "./accentWash";

interface Flash {
  key: number;
  color: string;
  opacity: number;
}

/**
 * 接続切替 (#978) 時の控えめなアクセント/環境ウォッシュ。`ThemeTransition` と
 * 同じポータル方式のクロスフェードで、新しい接続の環境色 (`titleBarContext` の
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
    if (!shouldFireAccentWash(prev.current, connectionKey)) {
      prev.current = connectionKey;
      return;
    }
    prev.current = connectionKey;
    const spec = accentWashSpec(connection);
    if (!spec) return;
    counter.current += 1;
    setFlash({ key: counter.current, color: spec.color, opacity: spec.opacity });
  }, [connectionKey, connection]);

  return createPortal(
    <AnimatePresence>
      {flash && (
        <motion.div
          key={flash.key}
          aria-hidden
          initial={{ opacity: flash.opacity }}
          animate={{ opacity: 0 }}
          exit={{ opacity: 0 }}
          transition={transitions.emphasized}
          onAnimationComplete={() => setFlash(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: flash.color,
            pointerEvents: "none",
            zIndex: "var(--z-toast)" as unknown as number,
          }}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}
