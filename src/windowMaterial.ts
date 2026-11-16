import { useEffect, useState } from "react";
import { api } from "./api/tauri";
import type { WindowMaterial } from "./settings";

/**
 * ウィンドウ素材 (Mica) の実効値を決める純関数 (#2359)。
 *
 * 設定値 `preference` をそのまま使うのは、素材を使える環境 (`supported` = Windows 11) で、かつ
 * ハイコントラスト (`hc-*` テーマ / OS の「コントラストを上げる」) でないときだけ。それ以外は
 * `none` に戻し、不透明な従来の表示にする。
 */
export function effectiveWindowMaterial(
  preference: WindowMaterial,
  supported: boolean,
  highContrast: boolean,
): WindowMaterial {
  if (!supported || highContrast) return "none";
  return preference;
}

/** 問い合わせ結果は起動中ずっと変わらないので、最初の 1 回だけ Rust へ聞いて共有する。 */
let supportedPromise: Promise<boolean> | null = null;

function querySupported(): Promise<boolean> {
  supportedPromise ??= api.windowMaterialSupported().catch(() => false);
  return supportedPromise;
}

/** この OS がウィンドウ素材 (Windows 11 の Mica) に対応しているか。判明するまでは false。 */
export function useWindowMaterialSupported(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let alive = true;
    void querySupported().then((v) => {
      if (alive) setSupported(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return supported;
}
