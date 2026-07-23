import React from "react";
import ReactDOM from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { MotionConfig } from "motion/react";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import { system } from "./theme";
import { useSettings } from "./settings";
import "./App.css";

/**
 * モーション量コントロール (#787)。`settings.motionPreference` を `MotionConfig`
 * の `reducedMotion` へマップするラッパー。`system` (既定) は従来どおり OS の
 * `prefers-reduced-motion` に追従する `"user"`、`reduced` は OS 設定に関わらず
 * 常に抑制する `"always"`、`full` は OS 設定に関わらず常に有効化する `"never"`。
 * `useSettings` (`useSyncExternalStore`) 経由なので設定変更が即座に反映される。
 * CSS 側の抑制 (`App.css` の `:root[data-motion=...]`) は別途 `App.tsx` が
 * `data-motion` 属性を同じ設定値から反映する。
 */
function MotionRoot({ children }: { children: React.ReactNode }) {
  const settings = useSettings();
  const reducedMotion =
    settings.motionPreference === "reduced"
      ? "always"
      : settings.motionPreference === "full"
        ? "never"
        : "user";
  return <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ChakraProvider value={system}>
      <MotionRoot>
        <ToastProvider>
          <App />
        </ToastProvider>
      </MotionRoot>
    </ChakraProvider>
  </React.StrictMode>,
);
