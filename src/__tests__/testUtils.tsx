// コンポーネントテスト共通の描画ヘルパ。アプリ本体 (`main.tsx`) と同じ
// `ChakraProvider value={system}` でラップし、Chakra の recipe / トークン /
// Portal が実アプリと同じ条件で動くようにする。
// `ToastProvider` も同居させて `useToast()` フックを使うコンポーネントを
// テストできるようにする。
import type { ReactElement, ReactNode } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "../theme";
import { ToastProvider } from "../components/Toast";

function Providers({ children }: { children: ReactNode }) {
  return (
    <ChakraProvider value={system}>
      <ToastProvider>{children}</ToastProvider>
    </ChakraProvider>
  );
}

export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
) {
  return render(ui, { wrapper: Providers, ...options });
}

// テスト側が個別に testing-library を import しなくて済むよう再エクスポートする。
export * from "@testing-library/react";
