import { chakra } from "@chakra-ui/react";

/**
 * 全画面サーフェス/主要パネルの最上位見出し直下に引くブランド罫線 (#1938)。
 *
 * `Modal.tsx` のヘッダ罫線 (#1878) と同じ `--hero-rule` / `--hero-rule-display` を使う。
 * 値は App.css が単一ソースで、ダーク系・hc-* では `none` 化されるため、その場合は
 * 親ヘッダの素の `app.border` 罫線へ自然に落ちる。罫線の 1px を覆うように下端へ重ねるので、
 * 親は `position: relative` (= `chakra.header` の `position="relative"`) にすること。
 * 内部の小見出しには使わない (最上位見出しだけ)。
 */
export function SurfaceRule() {
  return (
    <chakra.div
      aria-hidden
      data-testid="surface-brand-rule"
      css={{
        position: "absolute",
        insetInline: 0,
        bottom: "-1px",
        height: "2px",
        background: "var(--hero-rule)",
        display: "var(--hero-rule-display)",
        pointerEvents: "none",
      }}
    />
  );
}
