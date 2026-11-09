import { useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import type { ExtensionDependent } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { transitions, variants } from "../motion";
import { Callout } from "./Callout";
import {
  formatExtensionDependent,
  groupExtensionDependents,
  type ExtensionDependentKind,
} from "./extensionSql";
import { Icon } from "./Icon";
import { ErrorNote } from "./modalForm";
import { prefersStaticMotion } from "./revealOrigin";
import { Spinner } from "./Spinner";

/**
 * 拡張機能の削除確認で出す「依存するオブジェクト」の一覧 (#2177)。`DROP EXTENSION ... CASCADE` で一緒に
 * 消えるもの (その拡張の型を使う列・関数・ビューなど) を、実行前に種別ごとの件数見出し + 展開で見せる。
 * 列は消すとデータが失われるので、危険色で先頭に置く。CASCADE なしで依存があるときは「このままでは失敗する」
 * ことを事前に示す。取得に失敗しても削除自体は妨げない (呼び出し側はボタンを止めない)。
 */
interface Props {
  /** 取得結果。`null` は取得中。 */
  dependents: ExtensionDependent[] | null;
  /** 取得に失敗したときのメッセージ。 */
  error: string | null;
  cascade: boolean;
}

// motion.* に chakra のスタイル props を渡す (Callout と同じ forwardProps パターン)。
const MotionDiv = chakra(
  motion.div,
  {},
  { forwardProps: ["layout", "variants", "initial", "animate", "exit", "transition"] },
);

const KIND_LABEL: Record<ExtensionDependentKind, I18nKey> = {
  column: "extensionsDepsKind_column",
  table: "extensionsDepsKind_table",
  view: "extensionsDepsKind_view",
  materialized_view: "extensionsDepsKind_materialized_view",
  function: "extensionsDepsKind_function",
  procedure: "extensionsDepsKind_procedure",
  index: "extensionsDepsKind_index",
  constraint: "extensionsDepsKind_constraint",
  trigger: "extensionsDepsKind_trigger",
  default: "extensionsDepsKind_default",
  policy: "extensionsDepsKind_policy",
  statistic: "extensionsDepsKind_statistic",
  sequence: "extensionsDepsKind_sequence",
  type: "extensionsDepsKind_type",
  rule: "extensionsDepsKind_rule",
  extension: "extensionsDepsKind_extension",
  other: "extensionsDepsKind_other",
};

/** この件数を超える一覧は表示を打ち切る (数千件で DOM を膨らませない)。 */
const LIST_MAX = 200;

const INSTANT = { duration: 0 } as const;

export function ExtensionDependents({ dependents, error, cascade }: Props) {
  const t = useT();
  const reduced = useReducedMotionConfig() ?? false;
  // reduced-motion (アプリ設定 / OS) とハイコントラストでは開閉を即時にする。height の補間は MotionConfig では止まらない。
  const still = reduced || prefersStaticMotion();
  const groups = useMemo(() => groupExtensionDependents(dependents ?? []), [dependents]);
  // 列 (データが消える) の見出しだけ最初から開いておく。
  const [open, setOpen] = useState<ReadonlySet<ExtensionDependentKind>>(new Set(["column"]));

  if (error) return <ErrorNote>{t("extensionsDepsError", { error })}</ErrorNote>;
  if (dependents === null) {
    return (
      <chakra.div display="flex" alignItems="center" gap="2" textStyle="caption" color="app.textMuted">
        <Spinner size={12} decorative />
        {t("extensionsDepsLoading")}
      </chakra.div>
    );
  }
  if (dependents.length === 0) {
    return (
      <chakra.p margin={0} textStyle="caption" color="app.textSuccess" role="status">
        {t("extensionsDepsNone")}
      </chakra.p>
    );
  }

  const toggle = (kind: ExtensionDependentKind) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });

  return (
    <chakra.div display="flex" flexDirection="column" gap="2">
      {cascade ? (
        <chakra.p margin={0} textStyle="body" fontWeight={600} color="app.text">
          {t("extensionsDepsCascadeTitle", { count: dependents.length })}
        </chakra.p>
      ) : (
        <Callout tone="danger" role="alert">
          {t("extensionsDepsWillFail", { count: dependents.length })}
        </Callout>
      )}
      <MotionDiv
        layout={!still}
        transition={still ? INSTANT : transitions.layout}
        borderWidth="1px"
        borderColor="app.border"
        borderRadius="md"
        overflow="hidden"
      >
        {groups.map(({ kind, items }) => {
          const isOpen = open.has(kind);
          const destructive = kind === "column";
          const panelId = `ext-deps-${kind}`;
          return (
            <MotionDiv
              key={kind}
              layout={!still}
              transition={still ? INSTANT : transitions.layout}
              borderBottomWidth="1px"
              borderColor="app.border"
              _last={{ borderBottomWidth: 0 }}
            >
              <chakra.button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => toggle(kind)}
                display="flex"
                alignItems="center"
                gap="2"
                width="100%"
                paddingX="3"
                paddingY="2"
                textAlign="left"
                textStyle="body"
                fontWeight={600}
                color={destructive ? "app.textError" : "app.text"}
                background="transparent"
                cursor="pointer"
                _hover={{ bg: "app.hover" }}
              >
                <Icon name={isOpen ? "chevron-down" : "chevron-right"} size="sm" />
                <span>
                  {t(KIND_LABEL[kind])} ({items.length})
                </span>
                {destructive && (
                  <chakra.span textStyle="caption" fontWeight={400}>
                    {t("extensionsDepsDataLoss")}
                  </chakra.span>
                )}
              </chakra.button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <MotionDiv
                    key="list"
                    id={panelId}
                    variants={variants.collapse}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    transition={still ? INSTANT : transitions.enter}
                  >
                    <chakra.ul
                      listStyleType="none"
                      margin={0}
                      paddingX="3"
                      paddingBottom="2"
                      maxH="12rem"
                      overflowY="auto"
                    >
                      {items.slice(0, LIST_MAX).map((d, i) => {
                        const label = formatExtensionDependent(d);
                        return (
                          <chakra.li
                            key={`${label}\u0000${i}`}
                            fontFamily="mono"
                            textStyle="caption"
                            color={destructive ? "app.textError" : "app.textSecondary"}
                            overflowWrap="anywhere"
                          >
                            {label}
                          </chakra.li>
                        );
                      })}
                      {items.length > LIST_MAX && (
                        <chakra.li textStyle="caption" color="app.textMuted">
                          … +{items.length - LIST_MAX}
                        </chakra.li>
                      )}
                    </chakra.ul>
                  </MotionDiv>
                )}
              </AnimatePresence>
            </MotionDiv>
          );
        })}
      </MotionDiv>
    </chakra.div>
  );
}
