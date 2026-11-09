import { Fragment, useMemo, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { motion, useReducedMotionConfig } from "motion/react";

import { durations, easings } from "../motion";
import type { ParamSpan } from "../queryParams";
import { CodePreview } from "./modalForm";

/**
 * パラメータ入力モーダルの展開後 SQL プレビュー (#2155)。入力行にフォーカスした欄に対応する箇所
 * (同じ名前が複数回出る場合や、位置で決まる `?` もすべて) を `app.accentHighlight` の背景で強調し、
 * 未入力の箇所は `app.textWarning` の点線下線で示す。
 *
 * 強調はフォーカス対象が変わるたびに短くフェードインする。`MotionConfig reducedMotion` は
 * opacity の補間を止めないので、`useReducedMotionConfig()` (OS 設定とアプリ内設定の両方) で即時化する。
 */

const MotionMark = chakra(
  motion.mark,
  {
    base: {
      color: "inherit",
      bg: "app.accentHighlight",
      borderRadius: "xs",
    },
  },
  { forwardProps: ["initial", "animate", "transition"] },
);

const UnfilledMark = chakra("span", {
  base: {
    textDecoration: "underline dotted",
    textDecorationColor: "app.textWarning",
    textUnderlineOffset: "var(--space-0-5)",
  },
});

interface Props {
  /** 展開後の SQL。 */
  sql: string;
  /** 展開後の SQL 上の各プレースホルダの範囲 (`substituteAllParamsWithSpans`)。 */
  spans: readonly ParamSpan[];
  /** いまフォーカスしている入力行のキー。 */
  focusKey: string | null;
  /** 未入力のキー。 */
  unfilledKeys: ReadonlySet<string>;
  maxH?: string;
}

export function ParamPreview({ sql, spans, focusKey, unfilledKeys, maxH }: Props) {
  const reduced = useReducedMotionConfig() ?? false;
  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    let pos = 0;
    spans.forEach((sp, i) => {
      if (sp.start < pos) return;
      const active = sp.key === focusKey;
      const unfilled = unfilledKeys.has(sp.key);
      if (!active && !unfilled) return;
      if (sp.start > pos) out.push(sql.slice(pos, sp.start));
      const text = sql.slice(sp.start, sp.end);
      const key = `${i}:${sp.key}`;
      let node: ReactNode = text;
      if (unfilled) node = <UnfilledMark data-unfilled="">{node}</UnfilledMark>;
      if (active) {
        node = (
          // フォーカス対象が変わるたびに再マウントして、短くフェードインさせる。
          <MotionMark
            key={`${key}:${focusKey}`}
            data-active=""
            initial={{ opacity: 0.35 }}
            animate={{ opacity: 1 }}
            transition={reduced ? { duration: 0 } : { duration: durations.quick, ease: easings.out }}
          >
            {node}
          </MotionMark>
        );
      }
      out.push(<Fragment key={key}>{node}</Fragment>);
      pos = sp.end;
    });
    out.push(sql.slice(pos));
    return out;
  }, [sql, spans, focusKey, unfilledKeys, reduced]);

  return (
    <CodePreview wrap maxH={maxH} data-testid="param-preview">
      {nodes}
    </CodePreview>
  );
}
