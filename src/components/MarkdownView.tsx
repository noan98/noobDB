import { Fragment, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { CodePreview } from "./modalForm";
import { parseMarkdown, type MdBlock, type MdInline } from "../markdownLite";

/**
 * `markdownLite.ts` の構文木を React 要素で描く (#2380)。HTML 文字列は一切作らず
 * `dangerouslySetInnerHTML` も使わないので、本文中の `<script>` などは文字のまま表示される。
 * リンクはアプリ内で画面遷移させない (Tauri の webview が外部 URL へ移ってしまうため)。
 * 下線付きの文字と、隣に URL を淡色で添えて見せるだけにする。
 */

const HEADING_SIZE = { 1: "xl", 2: "lg", 3: "base", 4: "md", 5: "md", 6: "md" } as const;

function Inline({ nodes }: { nodes: readonly MdInline[] }): ReactNode {
  return (
    <>
      {nodes.map((n, i) => {
        // 構文木は不変で並びも変わらないので、位置をキーにしてよい。
        const key = `${i}`;
        switch (n.t) {
          case "text":
            return <Fragment key={key}>{n.v}</Fragment>;
          case "code":
            return (
              <chakra.code
                key={key}
                fontFamily="mono"
                fontSize="0.92em"
                bg="app.toolbar"
                px="1"
                borderRadius="sm"
              >
                {n.v}
              </chakra.code>
            );
          case "strong":
            return (
              <chakra.strong key={key} fontWeight={700}>
                <Inline nodes={n.c} />
              </chakra.strong>
            );
          case "em":
            return (
              <chakra.em key={key} fontStyle="italic">
                <Inline nodes={n.c} />
              </chakra.em>
            );
          case "link":
            return (
              <Fragment key={key}>
                <chakra.span textDecoration="underline" color="app.accent">
                  <Inline nodes={n.c} />
                </chakra.span>
                <chakra.span color="app.textMuted"> ({n.href})</chakra.span>
              </Fragment>
            );
        }
      })}
    </>
  );
}

function Lines({ lines }: { lines: readonly MdInline[][] }): ReactNode {
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          <Inline nodes={l} />
        </Fragment>
      ))}
    </>
  );
}

function Block({ b }: { b: MdBlock }): ReactNode {
  switch (b.t) {
    case "heading":
      return (
        <chakra.div role="heading" aria-level={b.level} fontSize={HEADING_SIZE[b.level]} fontWeight={700}>
          <Inline nodes={b.c} />
        </chakra.div>
      );
    case "p":
      return (
        <chakra.p>
          <Lines lines={b.lines} />
        </chakra.p>
      );
    case "ul":
    case "ol": {
      const List = b.t === "ul" ? chakra.ul : chakra.ol;
      return (
        <List pl="5" listStyleType={b.t === "ul" ? "disc" : "decimal"}>
          {b.items.map((it, i) => (
            <li key={i}>
              <Inline nodes={it} />
            </li>
          ))}
        </List>
      );
    }
    case "code": {
      // フェンス内は SQL とは限らない (言語指定を見ない) ので CodePreview で素直に見せる。
      const raw = b.v;
      return <CodePreview maxH="320px">{raw}</CodePreview>;
    }
    case "quote":
      return (
        <chakra.blockquote borderLeft="3px solid" borderColor="app.borderStrong" pl="3" color="app.textMuted">
          <Lines lines={b.lines} />
        </chakra.blockquote>
      );
    case "hr":
      return <chakra.hr borderColor="app.border" />;
  }
}

export function MarkdownView({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <chakra.div
      display="flex"
      flexDirection="column"
      gap="2"
      fontSize="md"
      lineHeight="relaxed"
      color="app.text"
    >
      {blocks.map((b, i) => (
        <Block key={i} b={b} />
      ))}
    </chakra.div>
  );
}
