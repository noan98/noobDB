import { useEffect, useMemo, useRef, type ComponentProps } from "react";
import { useReducedMotionConfig } from "motion/react";
import { durations, easings, rowCrossfadeFrom } from "../motion";
import { SQL_TOKEN_STYLE, shouldHighlightSql, sqlHighlightSegments } from "./sqlHighlight";
import { CodePreview } from "./modalForm";

/**
 * SQL (DDL / DML) のプレビュー。`CodePreview` の SQL 版で、エディタと同じ `--syntax-*` 配色
 * (設定画面のシンタックス配色とテーマプリセットに追従) で色分けする (#2157)。
 *
 * - 色分けは `sqlHighlightSegments` (lezer による静的解析)。1 万行 / 50 万文字を超える SQL は単色に
 *   フォールバックする (`shouldHighlightSql`)。
 * - `sql` が空のときは `empty` (プレースホルダ文言) を単色で出す。
 * - 内容が変わったら、入力が落ち着いてから (`durations.med`) 全体を 1 回だけ軽くクロスフェードする。
 *   Web Animations API を `<pre>` 自身に当てるだけなので再マウントせず、スクロール位置も保つ。
 *   reduced-motion (OS 設定 / アプリ内設定) と `Element.animate` の無い環境 (jsdom) では再生しない。
 *
 * 見た目のオプション (`wrap` / `minH` / `maxH`) は `CodePreview` と同じ。
 */
export function SqlPreview({
  sql,
  driver,
  empty,
  ...rest
}: Omit<ComponentProps<typeof CodePreview>, "children"> & {
  sql: string;
  /** `mysql` / `postgres` / `sqlite`。方言ごとにキーワード・引用規則が違う。 */
  driver: string;
  /** `sql` が空のときに出す文言。 */
  empty?: string;
}) {
  const highlight = sql !== "" && shouldHighlightSql(sql);
  const segments = useMemo(
    () => (highlight ? sqlHighlightSegments(sql, driver) : null),
    [highlight, sql, driver],
  );

  const ref = useRef<HTMLPreElement>(null);
  const reduced = useReducedMotionConfig();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sql の変化だけを契機にする
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const el = ref.current;
      if (reducedRef.current || !el || typeof el.animate !== "function") return;
      el.animate([{ opacity: rowCrossfadeFrom }, { opacity: 1 }], {
        duration: durations.quick * 1000,
        easing: `cubic-bezier(${easings.standard.join(", ")})`,
      });
    }, durations.med * 1000);
    return () => clearTimeout(timer);
  }, [sql]);

  return (
    <CodePreview ref={ref} data-testid="sql-preview" data-sql-highlight={segments ? "on" : "off"} {...rest}>
      {segments
        ? segments.map((seg, i) =>
            seg.kind ? (
              <span key={i} style={SQL_TOKEN_STYLE[seg.kind]}>
                {seg.text}
              </span>
            ) : (
              seg.text
            ),
          )
        : sql || empty}
    </CodePreview>
  );
}
