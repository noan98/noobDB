import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { motion, useReducedMotionConfig } from "motion/react";
import { useT } from "../i18n";
import { findCredentialRanges } from "../sqlCredentials";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
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
 * `maskCredentials` を付けると、SQL 中の資格情報リテラル (`IDENTIFIED BY '…'` / `PASSWORD '…'` など。
 * 判定は `sqlCredentials.ts` の `findCredentialRanges`) を `'••••••••'` のチップで伏せ、横に「パスワードを表示」
 * ボタン (目のアイコン) を置く (#2175)。既定は伏せ字で、押している間だけ平文。表示するのは画面だけで、
 * 実行される SQL・`sql` プロップは変えない。切り替えは透明度のクロスフェード (reduced-motion は即時)。
 * 状態はこのコンポーネント内にあるので、ダイアログを閉じる (アンマウント) と伏せ字に戻る。
 * 本文を選択してコピーしても、伏せている間はチップの文字がコピーされる (平文はコピーされない)。
 * 色分けしない大きな SQL (単色フォールバック) でも同じように伏せる。
 *
 * 見た目のオプション (`wrap` / `minH` / `maxH`) は `CodePreview` と同じ。
 */
export function SqlPreview({
  sql,
  driver,
  empty,
  maskCredentials = false,
  ...rest
}: Omit<ComponentProps<typeof CodePreview>, "children"> & {
  sql: string;
  /** `mysql` / `postgres` / `sqlite`。方言ごとにキーワード・引用規則が違う。 */
  driver: string;
  /** `sql` が空のときに出す文言。 */
  empty?: string;
  /** 資格情報リテラルを伏せ字にし、「表示」切り替えを付ける (#2175)。 */
  maskCredentials?: boolean;
}) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  // 一度でも切り替えたあとだけクロスフェードする (初回表示では光らせない)。
  const [toggled, setToggled] = useState(false);
  const ranges = useMemo(
    () => (maskCredentials && sql !== "" ? findCredentialRanges(sql, driver) : []),
    [maskCredentials, sql, driver],
  );
  const highlight = sql !== "" && shouldHighlightSql(sql);
  const segments = useMemo(
    () => (highlight ? sqlHighlightSegments(sql, driver) : null),
    [highlight, sql, driver],
  );

  const ref = useRef<HTMLPreElement>(null);
  const reduced = useReducedMotionConfig();
  const body = useMemo(
    () =>
      ranges.length > 0
        ? renderWithCredentials(segments ?? [{ text: sql }], ranges, revealed, toggled, !!reduced)
        : null,
    [segments, sql, ranges, revealed, toggled, reduced],
  );
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  // 前回の sql と比べて変わったときだけ再生する (StrictMode の effect 二重実行で初回に光らないように)。
  const prevSql = useRef(sql);
  useEffect(() => {
    if (prevSql.current === sql) return;
    prevSql.current = sql;
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

  const plain = segments
    ? segments.map((seg, i) =>
        seg.kind ? (
          <span key={i} style={SQL_TOKEN_STYLE[seg.kind]}>
            {seg.text}
          </span>
        ) : (
          seg.text
        ),
      )
    : sql || empty;

  const pre = (
    <CodePreview ref={ref} data-testid="sql-preview" data-sql-highlight={segments ? "on" : "off"} {...rest}>
      {body ?? plain}
    </CodePreview>
  );
  if (ranges.length === 0) return pre;

  const label = revealed ? t("formPasswordHide") : t("formPasswordShow");
  return (
    <chakra.div display="flex" flexDirection="column" gap="1" minW="0">
      <chakra.div display="flex" justifyContent="flex-end">
        <Tooltip label={label}>
          <chakra.button
            type="button"
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            p="1"
            border="none"
            bg="transparent"
            color="app.textMuted"
            borderRadius="sm"
            _hover={{ bg: "app.hover", color: "app.text" }}
            aria-pressed={revealed}
            aria-label={label}
            data-testid="sql-preview-reveal"
            onClick={() => {
              setToggled(true);
              setRevealed((r) => !r);
            }}
          >
            <Icon name={revealed ? "eye-off" : "eye"} size={ICON_SIZES.md} />
          </chakra.button>
        </Tooltip>
      </chakra.div>
      {pre}
    </chakra.div>
  );
}

interface Seg {
  text: string;
  kind?: keyof typeof SQL_TOKEN_STYLE | null;
}

/**
 * 色分けセグメント列を資格情報の範囲で区切り、範囲内を 1 つの `CredentialLiteral` にまとめる。
 * `ranges` は昇順・非重複 (`findCredentialRanges` の保証)。
 */
function renderWithCredentials(
  segs: readonly Seg[],
  ranges: readonly { start: number; end: number }[],
  revealed: boolean,
  toggled: boolean,
  reduced: boolean,
): ReactNode[] {
  const out: ReactNode[] = [];
  let inRange: ReactNode[] | null = null;
  let ri = 0;
  let pos = 0;
  const node = (seg: Seg, text: string, key: string): ReactNode =>
    seg.kind ? (
      <span key={key} style={SQL_TOKEN_STYLE[seg.kind]}>
        {text}
      </span>
    ) : (
      text
    );
  const flush = () => {
    if (!inRange) return;
    out.push(
      <CredentialLiteral key={`c${ri}`} revealed={revealed} animate={toggled && !reduced}>
        {inRange}
      </CredentialLiteral>,
    );
    inRange = null;
    ri++;
  };
  segs.forEach((seg, si) => {
    let off = 0;
    while (off < seg.text.length) {
      const abs = pos + off;
      const r = ranges[ri];
      if (inRange && r && abs >= r.end) {
        flush();
        continue;
      }
      const cur = ranges[ri];
      if (!inRange && cur && abs >= cur.start) inRange = [];
      const limit = inRange && cur ? cur.end : cur ? cur.start : Infinity;
      const take = Math.min(seg.text.length - off, Math.max(limit - abs, 1));
      const piece = node(seg, seg.text.slice(off, off + take), `${si}-${off}`);
      if (inRange) inRange.push(piece);
      else out.push(piece);
      off += take;
    }
    pos += seg.text.length;
  });
  flush();
  return out;
}

/** 伏せ字チップ ↔ 平文の切り替え。切り替えたときだけ透明度を戻して見せる (reduced-motion は即時)。 */
function CredentialLiteral({
  revealed,
  animate,
  children,
}: {
  revealed: boolean;
  animate: boolean;
  children: ReactNode;
}) {
  return (
    <motion.span
      key={revealed ? "plain" : "masked"}
      data-credential={revealed ? "plain" : "masked"}
      initial={animate ? { opacity: rowCrossfadeFrom } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: durations.quick, ease: easings.standard }}
    >
      {revealed ? (
        children
      ) : (
        <chakra.span bg="app.hover" borderRadius="sm" px="1" color="app.textMuted">
          {"'••••••••'"}
        </chakra.span>
      )}
    </motion.span>
  );
}
