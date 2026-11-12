import { Box, chakra, VisuallyHidden } from "@chakra-ui/react";
import { motion } from "motion/react";
import { useT } from "../i18n";
import { transitions } from "../motion";
import { Icon, ICON_SIZES } from "./Icon";
import type { DdlStep } from "./onlineDdl";
import { stageLock, stageStatuses, type StageStatus, type StageTrackState } from "./ddlStageTrackModel";

/**
 * オンライン DDL の段階実行を、段階ごとのノードと段階間のコネクタで見せる部品 (#2263)。
 * 実行前の計画 (`plan`)・実行中の進捗 (`running`)・失敗 (`failed`) を同じ見た目で出す。
 *
 * - 状態は色だけに頼らない。未実行 = 段階番号 / 実行中 = 脈動する番号 / 完了 = チェック / 失敗 = × で、
 *   現在の段階 (実行中 or 失敗) は `aria-current="step"`、各ノードに読み上げ文を持たせる。
 * - 幅が狭いとき (コンテナ幅) は縦並び、広いときは横並び。コネクタは進捗に合わせて塗り進む (`transitions.progress`)。
 * - 脈動は App.css の `@keyframes pulse` (接続中ドットと同じ)。reduced-motion では CSS が止め、
 *   塗りの伸長は `MotionConfig reducedMotion` が即時化する。
 * - 段階が 1 つ以下なら何も出さない (区切る意味が無い)。色・寸法は `app.*` / spacing トークンだけ。
 */

const STATUS_COLOR: Record<StageStatus, string> = {
  pending: "app.textMuted",
  running: "app.accent",
  done: "app.textSuccess",
  failed: "app.textError",
};

const MotionFill = chakra(motion.div, {}, { forwardProps: ["initial", "animate", "transition"] });

function Marker({ status, index }: { status: StageStatus; index: number }) {
  const color = STATUS_COLOR[status];
  return (
    <Box
      aria-hidden="true"
      flexShrink={0}
      w="5"
      h="5"
      borderRadius="pill"
      borderWidth="1px"
      borderStyle="solid"
      borderColor={color}
      color={color}
      bg="app.surface"
      display="flex"
      alignItems="center"
      justifyContent="center"
      fontSize="2xs"
      textStyle="numeric"
      animation={status === "running" ? "pulse 1.2s ease-in-out infinite" : undefined}
      data-testid="ddl-stage-marker"
    >
      {status === "done" ? (
        <Icon name="check" size={ICON_SIZES.sm} />
      ) : status === "failed" ? (
        <Icon name="close" size={ICON_SIZES.sm} />
      ) : (
        index + 1
      )}
    </Box>
  );
}

function Connector({ filled }: { filled: boolean }) {
  const fill = {
    bg: "app.textSuccess",
    borderRadius: "pill",
    position: "absolute" as const,
    inset: "0",
    initial: false,
    transition: transitions.progress,
  };
  return (
    <Box
      aria-hidden="true"
      data-testid="ddl-stage-connector"
      data-filled={filled ? "true" : "false"}
      position="relative"
      bg="app.border"
      borderRadius="pill"
      overflow="hidden"
      flexShrink={0}
      css={{
        // 縦並び: 細い縦線 (マーカー中心に揃える)。横並び: 伸びる横線。
        width: "var(--space-0-5)",
        height: "var(--space-3)",
        marginInlineStart: "calc(var(--space-2-5) - var(--space-0-25))",
        "& .col-fill": { display: "block" },
        "& .row-fill": { display: "none" },
        "@container (min-width: 36rem)": {
          width: "auto",
          height: "var(--space-0-5)",
          flex: "1 1 var(--space-4)",
          minWidth: "var(--space-4)",
          marginInlineStart: "var(--space-1-5)",
          marginInlineEnd: "var(--space-1-5)",
          marginTop: "calc(var(--space-2-5) - var(--space-0-25))",
          "& .col-fill": { display: "none" },
          "& .row-fill": { display: "block" },
        },
      }}
    >
      <MotionFill
        className="col-fill"
        {...fill}
        style={{ transformOrigin: "top" }}
        animate={{ scaleY: filled ? 1 : 0 }}
      />
      <MotionFill
        className="row-fill"
        {...fill}
        style={{ transformOrigin: "left" }}
        animate={{ scaleX: filled ? 1 : 0 }}
      />
    </Box>
  );
}

export function DdlStageTrack({ steps, state }: { steps: readonly DdlStep[]; state: StageTrackState }) {
  const t = useT();
  if (steps.length <= 1) return null;
  const statuses = stageStatuses(steps.length, state);
  const appliedUpTo = state.kind === "failed" && state.failedIndex > 0 ? state.failedIndex - 1 : -1;
  return (
    <Box css={{ containerType: "inline-size" }} data-testid="ddl-stage-track" data-state={state.kind}>
      <chakra.ol
        aria-label={t("ddlTrackLabel")}
        listStyleType="none"
        m="0"
        p="0"
        display="flex"
        flexDirection="column"
        alignItems="stretch"
        css={{ "@container (min-width: 36rem)": { flexDirection: "row", alignItems: "flex-start" } }}
      >
        {steps.map((step, i) => {
          const status = statuses[i];
          const label = t(`ddlTrackPhase_${step.phase}`);
          const current = status === "running" || status === "failed";
          return (
            <chakra.li
              key={i}
              display="flex"
              flexDirection="column"
              minW="0"
              css={{
                "@container (min-width: 36rem)": {
                  flexDirection: "row",
                  alignItems: "flex-start",
                  flex: i < steps.length - 1 ? "1 1 0" : "0 1 auto",
                },
              }}
              aria-current={current ? "step" : undefined}
              data-testid="ddl-stage"
              data-status={status}
            >
              <Box display="flex" alignItems="flex-start" gap="2" minW="0">
                <Marker status={status} index={i} />
                <Box display="flex" flexDirection="column" gap="0.5" minW="0" aria-hidden="true">
                  <chakra.span fontSize="sm" color={status === "pending" ? "app.textMuted" : "app.text"}>
                    {label}
                  </chakra.span>
                  {step.subject && (
                    <chakra.span textStyle="caption" fontFamily="mono" wordBreak="break-all">
                      {step.subject}
                    </chakra.span>
                  )}
                  <chakra.span textStyle="caption" data-testid="ddl-stage-lock" data-lock={stageLock(step)}>
                    {t(`ddlTrackLock_${stageLock(step)}`)}
                  </chakra.span>
                  {status === "failed" && (
                    <chakra.span textStyle="caption" color="app.textError">
                      {t("ddlTrackStatus_failed")}
                    </chakra.span>
                  )}
                  {i === appliedUpTo && (
                    <chakra.span textStyle="caption" color="app.textSuccess" data-testid="ddl-stage-applied">
                      {t("ddlTrackAppliedUpTo")}
                    </chakra.span>
                  )}
                </Box>
                <VisuallyHidden>
                  {[
                    t("ddlTrackStage", {
                      n: i + 1,
                      total: steps.length,
                      label: step.subject ? `${label} (${step.subject})` : label,
                      status: t(`ddlTrackStatus_${status}`),
                    }),
                    t(`ddlTrackLock_${stageLock(step)}`),
                    i === appliedUpTo ? t("ddlTrackAppliedUpTo") : null,
                  ]
                    .filter(Boolean)
                    .join(". ")}
                </VisuallyHidden>
              </Box>
              {i < steps.length - 1 && <Connector filled={status === "done"} />}
            </chakra.li>
          );
        })}
      </chakra.ol>
    </Box>
  );
}
