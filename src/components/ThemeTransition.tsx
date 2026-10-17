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

/** テーマトグルのクリックから切替までは即時なので、直近のポインタ操作だけを原点に使う。 */
const ORIGIN_MAX_AGE_MS = 1000;

interface Flash {
  key: number;
  origin: RevealPoint;
  plain: boolean;
  /** 切替前のテーマの地色 (穴の外側を覆う色)。 */
  oldBg: string;
}

/**
 * テーマ切替時のオーバーレイ。`themeKey` (= data-theme) が変わると、新しいテーマの
 * 旧テーマの地色で全画面を覆い、トリガー点 (テーマトグルを押した位置) を原点とする
 * 円形の穴を広げて新テーマを見せ、トークンの瞬時切替に因果を持たせる (#1582)。ポインタ操作が無い
 * (ショートカット / コマンドパレット) ときは画面中央が原点。初回マウント時は
 * 再生しない。reduced-motion と高コントラスト (hc-*) では円を使わず従来の
 * 全画面クロスフェードにする (`CircularReveal`)。
 */
export function ThemeTransition({ themeKey }: { themeKey: string }) {
  const [flash, setFlash] = useState<Flash | null>(null);
  const prev = useRef(themeKey);
  const counter = useRef(0);

  useEffect(() => {
    installRevealOriginTracking();
  }, []);

  useEffect(() => {
    if (prev.current === themeKey) return;
    prev.current = themeKey;
    // 子の effect は親 (App) が data-theme を書き換える effect より先に走るので、ここでは旧値が取れる。
    const oldBg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    counter.current += 1;
    setFlash({
      key: counter.current,
      origin: resolveRevealOrigin(performance.now(), ORIGIN_MAX_AGE_MS, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
      plain: isHighContrastDataTheme(themeKey),
      oldBg: oldBg || "var(--bg)",
    });
  }, [themeKey]);

  return createPortal(
    <AnimatePresence>
      {flash && (
        <CircularReveal
          key={flash.key}
          origin={flash.origin}
          variant="hole"
          color={flash.oldBg}
          flatColor="var(--bg)"
          flatOpacity={0.5}
          plain={flash.plain}
          onDone={() => setFlash(null)}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}
