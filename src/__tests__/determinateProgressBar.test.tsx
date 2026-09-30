import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChakraProvider } from "@chakra-ui/react";
import { DeterminateProgressBar } from "../components/StreamProgressBar";
import { system } from "../theme";

function bar(value: number) {
  const { container } = render(
    <ChakraProvider value={system}>
      <DeterminateProgressBar value={value} />
    </ChakraProvider>,
  );
  return container.querySelector<HTMLElement>("[aria-hidden] > div") as HTMLElement;
}

const widthOf = (el: HTMLElement) => () => el.style.width;

describe("DeterminateProgressBar", () => {
  it("割合に応じた width を持つ (範囲外はクランプ)", async () => {
    const el = bar(0.5);
    await waitFor(() => expect(widthOf(el)()).toBe("50%"));
  });
  it("1 超・負値は [0,100]% に収める", async () => {
    const hi = bar(3);
    await waitFor(() => expect(widthOf(hi)()).toBe("100%"));
    const lo = bar(-1);
    await waitFor(() => expect(widthOf(lo)()).toBe("0%"));
  });
});
