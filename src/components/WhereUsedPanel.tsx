import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";
import { motion, useReducedMotion } from "motion/react";

import {
  api,
  listenWhereUsedStream,
  type SchemaObjectKind,
  type WhereUsedMatch,
  type WhereUsedProgress,
  type WhereUsedReport,
  type WhereUsedTarget,
} from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { staggerContainer, variants } from "../motion";
import { semanticColorToken } from "../semanticColors";
import { EmptyState } from "./EmptyState";
import { errorIllustration } from "./illustrations";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import { FieldError, FieldLabel } from "./modalForm";
import { progressRatio } from "./progressRatio";
import { DeterminateProgressBar } from "./StreamProgressBar";
import { Tooltip } from "./Tooltip";
import { Button, Input } from "./ui";
import {
  sortWhereUsedMatches,
  splitHighlightSegments,
  unsupportedWhereUsedKinds,
} from "./whereUsed";

/**
 * オブジェクト依存検索 / 影響分析 (#1027) のボトムパネル。
 *
 * 「DROP / RENAME の前に参照元を確かめながら DDL を書く」ための参照情報なので、
 * `.claude/rules/ui-design-system.md` §7.1 に従い全画面ではなくボトムパネルに置く
 * (開いてもエディタと結果が消えない)。見出しと閉じるボタンはシェル側が持つ。
 *
 * 走査は Rust の `find_where_used` (#1261) が行う — ビュー・ルーチン・トリガーの定義本文を
 * バックエンドでまとめて取得して識別子を照合し、保存済みスニペットも走査して、ヒット位置
 * だけを Tauri Channel で返す。いずれも読み取りなので read_only セッションでも動く。
 * ここは入力フォームと結果の描画だけを担い、並べ替え・強調区間の分割は純モジュール
 * `whereUsed.ts`。
 *
 * 進捗 (n / 総数) とキャンセルを出す。キャンセルすると未走査の分は取りに行かず、途中
 * までの結果を表示する。
 */

/** stagger 出現させる先頭行数の上限 (大量ヒット時に出現が間延びしないよう)。 */
const STAGGER_CAP = 20;

// motion 用 props は Chakra のスタイルプロップに飲まれないよう forwardProps で素通しする。
const MotionUl = chakra(motion.ul, {}, { forwardProps: ["variants", "initial", "animate"] });
const MotionLi = chakra(motion.li, {}, { forwardProps: ["variants"] });

/** スキーマツリー / コマンドパレットからの検索要求。`autoRun` なら開いた直後に走らせる。 */
export interface WhereUsedRequest {
  target: WhereUsedTarget;
  autoRun: boolean;
}

let whereUsedStreamSeq = 0;
/** 走査 1 回ごとの一意な stream id (進捗・結果の宛先とキャンセルの宛先)。 */
function makeWhereUsedStreamId(): string {
  whereUsedStreamSeq += 1;
  return `whereused_${Date.now().toString(36)}_${whereUsedStreamSeq.toString(36)}`;
}

const KIND_LABEL: Record<SchemaObjectKind | "snippet", I18nKey> = {
  view: "objGroupViews",
  materialized_view: "objGroupMatViews",
  procedure: "objGroupProcedures",
  function: "objGroupFunctions",
  trigger: "objGroupTriggers",
  snippet: "whereUsedKindSnippet",
};

const KIND_ICON: Record<SchemaObjectKind | "snippet", IconName> = {
  view: "view",
  materialized_view: "view",
  procedure: "routine",
  function: "routine",
  trigger: "trigger",
  snippet: "snippet",
};

function targetLabel(t: WhereUsedTarget): string {
  return t.column ? `${t.table}.${t.column}` : t.table;
}

export function WhereUsedPanel({
  sessionId,
  driver,
  defaultDatabase,
  request,
  onRequestConsumed,
  onOpenObject,
  onOpenSnippet,
}: {
  sessionId: string;
  driver: string;
  /** フォームの初期データベース (アクティブタブ → プロファイル既定)。 */
  defaultDatabase: string;
  request: WhereUsedRequest | null;
  /** `autoRun` の要求を処理したことを App に伝える (再マウントで再実行しないため)。 */
  onRequestConsumed: () => void;
  onOpenObject: (database: string, kind: string, name: string, id: string | null) => void;
  onOpenSnippet: (snippetId: string) => void;
}) {
  const t = useT();
  const formId = useId();

  const [database, setDatabase] = useState(request?.target.database ?? defaultDatabase);
  const [table, setTable] = useState(request?.target.table ?? "");
  const [column, setColumn] = useState(request?.target.column ?? "");
  const [report, setReport] = useState<WhereUsedReport | null>(null);
  const [scannedTarget, setScannedTarget] = useState<WhereUsedTarget | null>(null);
  const [progress, setProgress] = useState<WhereUsedProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** 走査中のストリーム。別の走査を始める・アンマウントするときに止める。 */
  const activeRef = useRef<{ streamId: string; unlisten: () => void } | null>(null);

  const running = progress !== null;

  /** 走査中のストリームを止めて Channel の購読を外す (届いていない結果は捨てる)。 */
  const stopActive = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    active.unlisten();
    void api.cancelStream(active.streamId).catch(() => {});
  }, []);

  const run = useCallback(
    async (target: WhereUsedTarget) => {
      if (!target.table.trim()) {
        setFormError(t("whereUsedNeedTable"));
        return;
      }
      stopActive();
      const streamId = makeWhereUsedStreamId();
      const slot = { streamId, unlisten: () => {} };
      activeRef.current = slot;
      const isActive = () => activeRef.current === slot;
      /** この走査を終える (最新の走査のときだけ状態を戻す)。 */
      const settle = () => {
        if (!isActive()) return;
        activeRef.current = null;
        setProgress(null);
        slot.unlisten();
      };
      const show = (r: WhereUsedReport) => {
        if (!isActive()) return;
        setReport({ ...r, matches: sortWhereUsedMatches(r.matches) });
        settle();
      };
      setFormError(null);
      setError(null);
      setReport(null);
      setScannedTarget(target);
      setProgress({ done: 0, total: 0 });
      try {
        slot.unlisten = await listenWhereUsedStream(streamId, {
          onProgress: (p) => {
            if (isActive()) setProgress(p);
          },
          onDone: ({ report: r }) => show(r),
          onCancelled: ({ report: r }) => show(r),
          onError: ({ error: message }) => {
            if (!isActive()) return;
            setError(message);
            settle();
          },
        });
        if (!isActive()) {
          // listen の完了を待つ間に別の走査が始まった / アンマウントされた。
          slot.unlisten();
          return;
        }
        await api.findWhereUsed({ sessionId, streamId, database: target.database, target });
      } catch (e) {
        if (!isActive()) return;
        setError(String(e));
        settle();
      }
    },
    [sessionId, stopActive, t],
  );

  // ツリーの右クリック / コマンドパレットからの要求: フォームを埋め、必要なら走らせる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: run / onRequestConsumed は再生成されるため依存に入れず、要求オブジェクトの変化だけで 1 度実行する (下のコメント参照)
  useEffect(() => {
    if (!request) return;
    setDatabase(request.target.database);
    setTable(request.target.table);
    setColumn(request.target.column ?? "");
    if (request.autoRun) {
      onRequestConsumed();
      void run(request.target);
    }
    // run / onRequestConsumed の再生成では再実行しない (要求オブジェクトの変化だけを見る)。
  }, [request]);

  // アンマウント (タブ切替・切断) で走査を止める。
  useEffect(() => stopActive, [stopActive]);

  // キャンセル: バックエンドが走査を止め、そこまでの結果を `cancelled` つきで返す。
  const cancel = useCallback(() => {
    const active = activeRef.current;
    if (active) void api.cancelStream(active.streamId).catch(() => {});
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run({ database: database.trim(), table: table.trim(), column: column.trim() || null });
  };

  const unsupported = unsupportedWhereUsedKinds(driver);

  return (
    <Box flex="1" overflowY="auto" py="3.5" px="4" display="flex" flexDirection="column" gap="3">
      <chakra.p margin={0} fontSize="sm" color="app.textMuted">
        {t("whereUsedDesc")}
      </chakra.p>

      <chakra.form onSubmit={submit} display="flex" alignItems="flex-end" gap="3" flexWrap="wrap">
        <Flex direction="column" gap="1">
          <FieldLabel htmlFor={`${formId}-db`}>{t("whereUsedDatabase")}</FieldLabel>
          <Input
            id={`${formId}-db`}
            width="160px"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            spellCheck={false}
          />
        </Flex>
        <Flex direction="column" gap="1">
          <FieldLabel htmlFor={`${formId}-table`}>{t("whereUsedTable")}</FieldLabel>
          <Input
            id={`${formId}-table`}
            width="180px"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            spellCheck={false}
            aria-invalid={formError ? true : undefined}
          />
        </Flex>
        <Flex direction="column" gap="1">
          <FieldLabel htmlFor={`${formId}-col`}>{t("whereUsedColumn")}</FieldLabel>
          <Input
            id={`${formId}-col`}
            width="200px"
            value={column}
            placeholder={t("whereUsedColumnPlaceholder")}
            onChange={(e) => setColumn(e.target.value)}
            spellCheck={false}
          />
        </Flex>
        {running ? (
          <Button type="button" variant="secondary" onClick={cancel}>
            <Icon name="close" size={ICON_SIZES.sm} />
            <chakra.span marginLeft="1.5">{t("whereUsedCancel")}</chakra.span>
          </Button>
        ) : (
          <Button type="submit" variant="primary">
            <Icon name="search" size={ICON_SIZES.sm} />
            <chakra.span marginLeft="1.5">{t("whereUsedRun")}</chakra.span>
          </Button>
        )}
        {progress && (
          <Flex direction="column" gap="1" alignSelf="center" minW="200px">
            <DeterminateProgressBar value={progressRatio(progress.done, progress.total)} />
            <chakra.span fontSize="sm" color="app.textMuted" textStyle="numeric" aria-live="polite">
              {t("whereUsedProgress", { done: progress.done, total: progress.total })}
            </chakra.span>
          </Flex>
        )}
      </chakra.form>

      {formError && (
        // 検索フォームの入力エラーはフィールド単位の FieldError (#1114)。
        <FieldError display="block">{formError}</FieldError>
      )}

      <chakra.div textStyle="caption" display="flex" flexDirection="column" gap="0.5">
        {unsupported.length > 0 && (
          <span>
            {t("whereUsedUnsupported", {
              kinds: unsupported.map((k) => t(KIND_LABEL[k])).join(" / "),
            })}
          </span>
        )}
        <span>{t("whereUsedDynamicNote")}</span>
      </chakra.div>

      {error && (
        <EmptyState
          illustration={errorIllustration(error)}
          icon="warning"
          title={t("whereUsedError", { error })}
          action={
            scannedTarget ? { label: t("whereUsedRun"), onClick: () => void run(scannedTarget) } : undefined
          }
        />
      )}

      {report && scannedTarget && (
        <WhereUsedResults
          report={report}
          target={scannedTarget}
          onOpenObject={onOpenObject}
          onOpenSnippet={onOpenSnippet}
        />
      )}
    </Box>
  );
}

function WhereUsedResults({
  report,
  target,
  onOpenObject,
  onOpenSnippet,
}: {
  report: WhereUsedReport;
  target: WhereUsedTarget;
  onOpenObject: (database: string, kind: string, name: string, id: string | null) => void;
  onOpenSnippet: (snippetId: string) => void;
}) {
  const t = useT();
  const reduced = useReducedMotion() ?? false;
  const counts = {
    target: targetLabel(target),
    matches: report.matches.length,
    objects: report.scannedObjects,
    snippets: report.scannedSnippets,
  };
  return (
    <Flex direction="column" gap="2.5">
      {report.cancelled && (
        <chakra.div fontSize="sm" color="app.textWarning">
          {t("whereUsedCancelled")}
        </chakra.div>
      )}
      {report.matches.length === 0 ? (
        <EmptyState compact icon="search" title={t("whereUsedNone", counts)} />
      ) : (
        <chakra.div fontSize="sm" color="app.textMuted">
          {t("whereUsedSummary", counts)}
        </chakra.div>
      )}

      {report.matches.length > 0 && (
        <MotionUl
          variants={staggerContainer(reduced)}
          initial="initial"
          animate="animate"
          listStyleType="none"
          margin={0}
          padding={0}
          display="flex"
          flexDirection="column"
          gap="2"
        >
          {report.matches.map((m, i) => (
            <WhereUsedMatchRow
              animated={i < STAGGER_CAP}
              key={`${m.kind}:${m.name}:${m.id ?? m.snippetId ?? ""}`}
              match={m}
              onOpen={() =>
                m.source === "snippet" && m.snippetId
                  ? onOpenSnippet(m.snippetId)
                  : onOpenObject(target.database, m.kind, m.name, m.id)
              }
            />
          ))}
        </MotionUl>
      )}

      {report.failed.length > 0 && (
        <ProblemList
          title={t("whereUsedFailed", { count: report.failed.length })}
          items={report.failed.map((f) => `${t(KIND_LABEL[f.kind])} ${f.name}: ${f.error}`)}
        />
      )}
      {report.emptyDefinitions.length > 0 && (
        <ProblemList
          title={t("whereUsedEmptyDefs", { count: report.emptyDefinitions.length })}
          items={report.emptyDefinitions.map((f) => `${t(KIND_LABEL[f.kind])} ${f.name}`)}
        />
      )}
    </Flex>
  );
}

function WhereUsedMatchRow({
  match,
  onOpen,
  animated,
}: {
  match: WhereUsedMatch;
  onOpen: () => void;
  animated: boolean;
}) {
  const t = useT();
  return (
    <MotionLi
      variants={animated ? variants.staggerItem : undefined}
      border="1px solid"
      borderColor="app.border"
      borderRadius="md"
      bg="app.surface"
      px="3"
      py="2"
    >
      <Flex align="center" gap="2" flexWrap="wrap">
        <chakra.span display="inline-flex" alignItems="center" gap="1" fontSize="xs" color="app.textSecondary">
          <Icon name={KIND_ICON[match.kind]} size={ICON_SIZES.sm} />
          {t(KIND_LABEL[match.kind])}
        </chakra.span>
        <chakra.button
          type="button"
          onClick={onOpen}
          fontFamily="mono"
          fontSize="sm"
          fontWeight={600}
          color="app.accent"
          bg="transparent"
          border="none"
          padding={0}
          cursor="pointer"
          textAlign="left"
          _hover={{ textDecoration: "underline" }}
          aria-label={t("whereUsedOpen", { name: match.name })}
        >
          {match.name}
        </chakra.button>
        {match.confidence === "possible" && (
          <Tooltip label={t("whereUsedPossibleHint")}>
            <chakra.span
              px="1.5"
              py="0.25"
              textStyle="overline"
              borderRadius="sm"
              border="1px solid"
              borderColor={semanticColorToken("warning", "border")}
              bg={semanticColorToken("warning", "subtle")}
              color={semanticColorToken("warning", "text")}
              tabIndex={0}
            >
              {t("whereUsedPossible")}
            </chakra.span>
          </Tooltip>
        )}
        <chakra.span fontSize="xs" color="app.textMuted">
          {t("whereUsedHits", { count: match.hitCount })}
        </chakra.span>
      </Flex>
      <chakra.ol listStyleType="none" margin={0} marginTop="1.5" padding={0}>
        {match.lines.map((l) => (
          <chakra.li key={l.line} display="flex" gap="2" fontFamily="mono" fontSize="xs" lineHeight="snug">
            <chakra.span color="app.textMuted" minW="40px" textAlign="right" flexShrink={0}>
              {`L${l.line}`}
            </chakra.span>
            <chakra.span color="app.text" whiteSpace="pre-wrap" wordBreak="break-all">
              {l.clippedStart && "…"}
              {splitHighlightSegments(l.text, l.ranges).map((seg, i) =>
                seg.hit ? (
                  <chakra.mark
                    key={i}
                    bg="color-mix(in srgb, var(--accent) 35%, transparent)"
                    color="inherit"
                    borderRadius="xs"
                  >
                    {seg.text}
                  </chakra.mark>
                ) : (
                  <span key={i}>{seg.text}</span>
                ),
              )}
              {l.clippedEnd && "…"}
            </chakra.span>
          </chakra.li>
        ))}
      </chakra.ol>
    </MotionLi>
  );
}

function ProblemList({ title, items }: { title: string; items: string[] }) {
  return (
    <chakra.details textStyle="caption">
      <chakra.summary cursor="pointer">{title}</chakra.summary>
      <chakra.ul margin={0} marginTop="1" paddingLeft="4">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </chakra.ul>
    </chakra.details>
  );
}
