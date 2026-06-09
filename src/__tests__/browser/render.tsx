// 実ブラウザ (Vitest ブラウザモード / Playwright + headless Chromium) 用の描画
// ヘルパ (#306)。jsdom 版の `testUtils.tsx` と同じく、アプリ本体 (`main.tsx`) と
// 同一の `ChakraProvider value={system}` + `ToastProvider` でラップし、Chakra の
// recipe / トークン / Portal を実アプリと同じ条件で評価できるようにする。
//
// jsdom 版と分けているのは描画ランタイムが異なるため。jsdom テストは
// `@testing-library/react` の `render` を使うが、ブラウザモードでは実ブラウザに
// マウントする `vitest-browser-react` の `render` を使い、返ってくる locator
// (`screen.getByRole(...)` 等) は実 DOM に対する非同期クエリになる。
import type { ReactElement, ReactNode } from "react";
import { render } from "vitest-browser-react";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "../../theme";
import { ToastProvider } from "../../components/Toast";

function Providers({ children }: { children: ReactNode }) {
  return (
    <ChakraProvider value={system}>
      <ToastProvider>{children}</ToastProvider>
    </ChakraProvider>
  );
}

/**
 * 実ブラウザへコンポーネントをマウントする。返り値は `vitest-browser-react` の
 * レンダ結果で、`getByRole` などの locator を持つ (`render` は非同期なので await
 * する)。
 */
export function renderInBrowser(ui: ReactElement) {
  return render(<Providers>{ui}</Providers>);
}
