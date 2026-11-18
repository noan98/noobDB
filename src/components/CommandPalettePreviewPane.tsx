import { chakra, Box, Flex } from "@chakra-ui/react";
import { motion } from "motion/react";
import { forwardRef, useMemo, type ReactNode, type Ref } from "react";
import { useT, type I18nKey } from "../i18n";
import { transitions } from "../motion";
import { Button } from "./ui";
import { SqlPreview } from "./SqlPreview";
import { TypeGlyph, kindOfDataType } from "./TypeGlyph";
import { formatRowEstimate } from "./rowEstimate";
import type { CommandItem } from "./commandPaletteSearch";
import {
  PREVIEW_COLUMN_LIMIT,
  buildPreviewColumns,
  clipPreviewSql,
  previewKey,
  relativeExecutedAt,
  snippetPlaceholders,
  type HistoryMeta,
  type PreviewActionKind,
  type PreviewSource,
} from "./commandPalettePreview";
import type { TableDetailState } from "./useCommandPreviewDetail";

const MotionPane = chakra(motion.div, {}, { forwardProps: ["initial", "animate", "transition"] });

const ACTION_LABEL: Record<PreviewActionKind, I18nKey> = {
  insert: "cmdkPreviewActionInsert",
  open: "cmdkPreviewActionOpen",
  run: "cmdkPreviewActionRun",
};

/** アクションボタンを探すためのデータ属性 (パレットが Tab で先頭へフォーカスを移す)。 */
export const PREVIEW_ACTION_ATTR = "data-cmdk-preview-action";

interface PreviewPaneProps {
  /** 描画対象の候補。null (プレビューを持たない候補) は案内文を出す。 */
  item: CommandItem | null;
  /** 表示中のプレビューが、いま選択中の候補のものか (デバウンス待ちの間は false)。 */
  settled: boolean;
  detail: TableDetailState;
  /** 履歴の相対時刻の基準 (epoch ミリ秒)。 */
  now: number;
  reduced: boolean;
  onAction: (item: CommandItem, kind: PreviewActionKind) => void;
}

/**
 * コマンドパレットのプレビューペイン (#2425)。表示モデルの組み立ては
 * `commandPalettePreview.ts` に分けてあり、ここは描画だけを担う。候補が切り替わると
 * 短いクロスフェード (`transitions.crossfade`、reduced-motion では即時) で差し替える。
 */
export const PreviewPane = forwardRef(function PreviewPane(
  { item, settled, detail, now, reduced, onAction }: PreviewPaneProps,
  ref: Ref<HTMLDivElement>,
) {
  const t = useT();
  const source = item?.preview ?? null;
  return (
    <Box
      ref={ref}
      role="region"
      aria-label={t("cmdkPreviewRegion")}
      data-testid="cmdk-preview"
      flex={{ base: "none", md: "0 0 48%" }}
      minW={0}
      maxH="min(420px, 60vh)"
      overflowY="auto"
      bg="app.surface"
      borderLeftWidth={{ base: "0", md: "1px" }}
      borderTopWidth={{ base: "1px", md: "0" }}
      borderColor="app.border"
    >
      {item && source ? (
        <MotionPane
          key={previewKey(item.id)}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={reduced ? { duration: 0 } : transitions.crossfade}
          p="3.5"
          display="flex"
          flexDirection="column"
          gap="3"
        >
          <PreviewBody source={source} detail={detail} now={now} />
          {item.previewActions && item.previewActions.length > 0 && (
            <Flex gap="2" flexWrap="wrap" data-testid="cmdk-preview-actions">
              {item.previewActions.map((a) => (
                <Button
                  key={a.kind}
                  type="button"
                  variant="ghost"
                  size="sm"
                  {...{ [PREVIEW_ACTION_ATTR]: a.kind }}
                  disabled={!settled || !!a.disabledReason}
                  onClick={() => onAction(item, a.kind)}
                >
                  {t(ACTION_LABEL[a.kind])}
                </Button>
              ))}
            </Flex>
          )}
          {item.previewActions?.some((a) => a.disabledReason) && (
            <Box textStyle="caption" data-testid="cmdk-preview-disabled-reason">
              {item.previewActions.find((a) => a.disabledReason)?.disabledReason}
            </Box>
          )}
        </MotionPane>
      ) : (
        <Box p="4" fontSize="sm" color="app.textMuted" data-testid="cmdk-preview-empty">
          {t("cmdkPreviewEmpty")}
        </Box>
      )}
    </Box>
  );
});

function PreviewBody({
  source,
  detail,
  now,
}: {
  source: PreviewSource;
  detail: TableDetailState;
  now: number;
}) {
  switch (source.kind) {
    case "table":
      return <TablePreview source={source} detail={detail} />;
    case "snippet":
      return <SnippetPreview source={source} />;
    case "history":
      return <HistoryPreview source={source} now={now} />;
    case "connection":
      return <ConnectionPreview source={source} />;
  }
}

function Title({ children, sub }: { children: ReactNode; sub?: string | null }) {
  return (
    <Box minW={0}>
      <Box fontSize="md" fontWeight={600} overflowWrap="anywhere">
        {children}
      </Box>
      {sub && (
        <Box textStyle="caption" overflowWrap="anywhere">
          {sub}
        </Box>
      )}
    </Box>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex direction="column" gap="0.5" minW={0}>
      <Box textStyle="overline">{label}</Box>
      <Box fontSize="sm" overflowWrap="anywhere">
        {children}
      </Box>
    </Flex>
  );
}

function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warning" | "danger";
}) {
  const color =
    tone === "danger" ? "app.textError" : tone === "warning" ? "app.textWarning" : "app.textMuted";
  return (
    <chakra.span
      textStyle="overline"
      px="1.5"
      py="0.25"
      borderRadius="pill"
      borderWidth="1px"
      borderColor="app.border"
      color={color}
      whiteSpace="nowrap"
    >
      {children}
    </chakra.span>
  );
}

function TablePreview({
  source,
  detail,
}: {
  source: Extract<PreviewSource, { kind: "table" }>;
  detail: TableDetailState;
}) {
  const t = useT();
  const ready = detail.status === "ready" ? detail.detail : null;
  const columns = useMemo(() => buildPreviewColumns(source.columns, ready), [source.columns, ready]);
  const shown = columns.slice(0, PREVIEW_COLUMN_LIMIT);
  const rows = ready?.rowEstimate ?? null;
  return (
    <>
      <Title sub={source.database}>{source.table}</Title>
      {rows !== null && <Field label={t("cmdkPreviewRowsEstimate")}>{formatRowEstimate(rows) || "—"}</Field>}
      <Flex direction="column" gap="1">
        <Box textStyle="overline">{t("cmdkPreviewColumns", { count: columns.length })}</Box>
        {detail.status === "loading" && (
          <Box textStyle="caption" data-testid="cmdk-preview-loading">
            {t("cmdkPreviewLoadingDetail")}
          </Box>
        )}
        {detail.status === "error" && (
          <Box textStyle="caption" data-testid="cmdk-preview-detail-error">
            {t("cmdkPreviewDetailError")}
          </Box>
        )}
        <Flex as="ul" direction="column" gap="0.5" listStyleType="none" m="0" p="0">
          {shown.map((c) => (
            <Flex as="li" key={c.name} align="baseline" gap="2" fontSize="sm" minW={0}>
              <Box flexShrink={0} display="inline-flex" alignSelf="center" w="4">
                {c.dataType !== null && <TypeGlyph kind={kindOfDataType(c.dataType)} />}
              </Box>
              <chakra.span fontFamily="var(--font-mono)" overflowWrap="anywhere">
                {c.name}
              </chakra.span>
              {c.dataType !== null && (
                <chakra.span textStyle="caption" overflowWrap="anywhere">
                  {c.dataType}
                </chakra.span>
              )}
              {c.primaryKey && <Chip>{t("cmdkPreviewPrimaryKey")}</Chip>}
              {c.references && <Chip>{t("cmdkPreviewForeignKey", { target: c.references })}</Chip>}
              {c.comment && (
                <chakra.span textStyle="caption" overflowWrap="anywhere">
                  {c.comment}
                </chakra.span>
              )}
            </Flex>
          ))}
        </Flex>
        {columns.length > shown.length && (
          <Box textStyle="caption">
            {t("cmdkPreviewColumnsMore", { count: columns.length - shown.length })}
          </Box>
        )}
      </Flex>
    </>
  );
}

function SqlBlock({ sql, driver }: { sql: string; driver: string | null }) {
  const t = useT();
  const clipped = useMemo(() => clipPreviewSql(sql), [sql]);
  return (
    <Flex direction="column" gap="1" minW={0}>
      <SqlPreview
        sql={clipped.text}
        driver={driver ?? undefined}
        maskCredentials
        wrap
        maxH="min(280px, 40vh)"
      />
      {clipped.omitted > 0 && (
        <Box textStyle="caption">{t("cmdkPreviewSqlOmitted", { count: clipped.omitted })}</Box>
      )}
    </Flex>
  );
}

function SnippetPreview({ source }: { source: Extract<PreviewSource, { kind: "snippet" }> }) {
  const t = useT();
  const ph = useMemo(() => snippetPlaceholders(source.sql), [source.sql]);
  const scope =
    source.scope.kind === "any"
      ? t("snippetScopeAny")
      : source.scope.kind === "group"
        ? `${t("snippetScopeGroupLabel")}: ${source.scope.group}`
        : `${t("snippetScopeProfileLabel")}: ${source.scopeProfileName ?? t("snippetScopeDeletedProfile")}`;
  return (
    <>
      <Title sub={source.folder}>{source.name}</Title>
      <SqlBlock sql={source.sql} driver={source.driver} />
      <Field label={t("cmdkPreviewScope")}>{scope}</Field>
      {source.tags.length > 0 && (
        <Field label={t("cmdkPreviewTags")}>
          <Flex gap="1" flexWrap="wrap">
            {source.tags.map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
          </Flex>
        </Field>
      )}
      {ph.tabStops.length === 0 && ph.params.length === 0 ? (
        <Box textStyle="caption">{t("cmdkPreviewNoPlaceholders")}</Box>
      ) : (
        <>
          {ph.tabStops.length > 0 && (
            <Field label={t("cmdkPreviewTabStops")}>
              <chakra.span fontFamily="var(--font-mono)">{ph.tabStops.join(", ")}</chakra.span>
            </Field>
          )}
          {ph.params.length > 0 && (
            <Field label={t("cmdkPreviewParams")}>
              <chakra.span fontFamily="var(--font-mono)">
                {ph.params.map((p) => `{{${p}}}`).join(", ")}
              </chakra.span>
            </Field>
          )}
        </>
      )}
    </>
  );
}

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function HistoryPreview({
  source,
  now,
}: {
  source: Extract<PreviewSource, { kind: "history" }>;
  now: number;
}) {
  const t = useT();
  const meta: HistoryMeta | null = source.meta;
  const rel = meta ? relativeExecutedAt(meta.executedAt, now) : null;
  const relText = !rel
    ? null
    : rel.unit === "minutes"
      ? t("activityTimeMinutes", { n: rel.value })
      : rel.unit === "hours"
        ? t("activityTimeHours", { n: rel.value })
        : rel.unit === "days"
          ? t("activityTimeDays", { n: rel.value })
          : t("activityTimeNow");
  return (
    <>
      <SqlBlock sql={source.sql} driver={source.driver} />
      {meta ? (
        <Flex direction="column" gap="2">
          <Flex gap="1.5" flexWrap="wrap">
            <Chip tone={meta.ok ? "neutral" : "danger"}>
              {meta.ok ? t("cmdkPreviewStatusOk") : t("cmdkPreviewStatusError")}
            </Chip>
            {meta.rows !== null && <Chip>{t("cmdkPreviewResultRows", { count: meta.rows })}</Chip>}
            {meta.rowsAffected !== null && (
              <Chip>{t("cmdkPreviewResultAffected", { count: meta.rowsAffected })}</Chip>
            )}
          </Flex>
          {relText && <Field label={t("cmdkPreviewExecutedAt")}>{relText}</Field>}
          {meta.elapsedMs !== null && (
            <Field label={t("cmdkPreviewDuration")}>{formatElapsed(meta.elapsedMs)}</Field>
          )}
          {!meta.ok && meta.error && (
            <Box fontSize="xs" color="app.textError" overflowWrap="anywhere">
              {meta.error}
            </Box>
          )}
        </Flex>
      ) : (
        <Box textStyle="caption">{t("cmdkPreviewNoHistoryMeta")}</Box>
      )}
      {source.connectionName && <Field label={t("cmdkPreviewConnection")}>{source.connectionName}</Field>}
    </>
  );
}

function ConnectionPreview({ source }: { source: Extract<PreviewSource, { kind: "connection" }> }) {
  const t = useT();
  const host = source.host ? (source.port ? `${source.host}:${source.port}` : source.host) : null;
  return (
    <>
      <Title>{source.name}</Title>
      <Flex gap="1.5" flexWrap="wrap">
        <Chip>{source.driver.toUpperCase()}</Chip>
        {source.isProduction && <Chip tone="danger">{t("listProduction")}</Chip>}
        {source.readOnly && <Chip tone="warning">{t("listReadOnly")}</Chip>}
        {source.connected && <Chip>{t("cmdkBadgeConnected")}</Chip>}
      </Flex>
      {host && <Field label={t("cmdkPreviewHost")}>{host}</Field>}
      {source.database && <Field label={t("cmdkPreviewDatabase")}>{source.database}</Field>}
      {source.group && <Field label={t("cmdkPreviewGroup")}>{source.group}</Field>}
    </>
  );
}
