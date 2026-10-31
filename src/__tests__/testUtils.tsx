// コンポーネントテスト共通の描画ヘルパ。アプリ本体 (`main.tsx`) と同じ
// `ChakraProvider value={system}` でラップし、Chakra の recipe / トークン /
// Portal が実アプリと同じ条件で動くようにする。
// `ToastProvider` も同居させて `useToast()` フックを使うコンポーネントを
// テストできるようにする。
import type { ReactElement, ReactNode } from "react";
import { fireEvent, render, type RenderOptions } from "@testing-library/react";
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

export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, { wrapper: Providers, ...options });
}

// テスト側が個別に testing-library を import しなくて済むよう再エクスポートする。
export * from "@testing-library/react";

/**
 * `ListboxSelect` (トリガーは `role="combobox"` の `<button>`) を開いて `value` の候補を選ぶ。
 * ネイティブ `<select>` 時代の `fireEvent.change(select, { target: { value } })` /
 * `user.selectOptions` の置き換え。候補は `data-value` で特定する (表示ラベルに依存しない)。
 */
export function chooseListboxOption(trigger: HTMLElement, value: string) {
  fireEvent.click(trigger);
  const listboxId = trigger.getAttribute("aria-controls");
  const listbox = listboxId ? document.getElementById(listboxId) : null;
  if (!listbox) throw new Error("listbox が開いていません");
  const option = Array.from(listbox.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (el) => el.dataset.value === value,
  );
  if (!option) throw new Error(`候補 "${value}" が見つかりません`);
  fireEvent.click(option);
}
