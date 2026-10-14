import { chakra } from "@chakra-ui/react";
import type {
  ScriptAnalysis,
  ScriptAnalyzedEvent,
  ScriptAnalyzedStatement,
  ScriptDangerKind,
} from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { analysisIsTruncated, dangerKindCounts } from "../scriptRun";
import { textEncodingLabel } from "../sqlFileIO";
import { Callout } from "./Callout";
import { FieldLabel } from "./modalForm";
import { formatBytes } from "./tableSize";
import { Button, Checkbox } from "./ui";

const DANGER_LABELS: Record<ScriptDangerKind, I18nKey> = {
  drop: "scriptDangerDrop",
  truncate: "scriptDangerTruncate",
  deleteNoWhere: "scriptDangerDeleteNoWhere",
  updateNoWhere: "scriptDangerUpdateNoWhere",
};

const DANGER_KIND_LABELS: Record<ScriptDangerKind, I18nKey> = {
  drop: "scriptDangerKindDrop",
  truncate: "scriptDangerKindTruncate",
  deleteNoWhere: "scriptDangerKindDeleteNoWhere",
  updateNoWhere: "scriptDangerKindUpdateNoWhere",
};

const CATEGORY_LABELS: Record<ScriptAnalyzedStatement["category"], I18nKey> = {
  read: "scriptCategoryRead",
  write: "scriptCategoryWrite",
  ddl: "scriptCategoryDdl",
  txControl: "scriptCategoryTx",
};

/** トランザクション制御文の位置を何件まで本文に並べるか (残りは「ほか N 件」)。 */
const TX_MARKS_SHOWN = 6;

interface Props {
  event: ScriptAnalyzedEvent;
  /** 実行しない文の通し番号。 */
  excluded: ReadonlySet<number>;
  /** ファイル / 文字コードが変わって結果が古い。 */
  stale: boolean;
  disabled: boolean;
  onToggle: (index: number) => void;
  onExcludeDangerous: (exclude: boolean) => void;
}

/**
 * `.sql` スクリプトの事前確認 (ドライラン) の結果表示 (#1535)。文数・種別・危険文・
 * トランザクション制御文の位置・先頭の文の一覧を見せ、一覧の各文を実行対象から外せる。
 * 一覧はバックエンドが上限つきで保持した範囲だけ (全文はメモリにも画面にも載せない)。
 */
export function ScriptAnalysisPanel({
  event,
  excluded,
  stale,
  disabled,
  onToggle,
  onExcludeDangerous,
}: Props) {
  const t = useT();
  const a: ScriptAnalysis = event.analysis;
  const kinds = dangerKindCounts(a);
  const dangerUnlisted = Math.max(0, a.dangerousTotal - a.dangerous.length);
  const allDangerousExcluded = a.dangerous.length > 0 && a.dangerous.every((d) => excluded.has(d.index));
  const txShown = a.txControls.slice(0, TX_MARKS_SHOWN);

  return (
    <chakra.section
      aria-label={t("scriptAnalysisTitle")}
      display="flex"
      flexDirection="column"
      gap="2.5"
      p="3"
      borderWidth="1px"
      borderColor="app.border"
      borderRadius="md"
      opacity={stale ? 0.6 : 1}
    >
      <chakra.div display="flex" flexDirection="column" gap="0.5">
        <FieldLabel as="div">{t("scriptAnalysisTitle")}</FieldLabel>
        <chakra.span fontSize="sm" color="app.text">
          {t("scriptAnalysisSummary", {
            count: a.totalStatements.toLocaleString(),
            size: formatBytes(event.totalBytes),
            encoding: textEncodingLabel(event.encoding),
          })}
        </chakra.span>
        <chakra.span color="app.textMuted" textStyle="caption">
          {t("scriptAnalysisCategories", {
            read: a.categories.read.toLocaleString(),
            write: a.categories.write.toLocaleString(),
            ddl: a.categories.ddl.toLocaleString(),
            tx: a.categories.txControl.toLocaleString(),
          })}
        </chakra.span>
        {stale && (
          <chakra.span fontSize="xs" color="app.textWarning">
            {t("scriptAnalysisStale")}
          </chakra.span>
        )}
      </chakra.div>

      {a.blockedTotal > 0 && (
        <Callout tone="warning" role="status">
          {t("scriptAnalysisBlocked", { count: a.blockedTotal.toLocaleString() })}
        </Callout>
      )}

      {a.dangerousTotal > 0 && (
        <Callout
          tone="danger"
          role="status"
          title={t("scriptAnalysisDangerTitle", { count: a.dangerousTotal.toLocaleString() })}
          action={
            a.dangerous.length > 0 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => onExcludeDangerous(!allDangerousExcluded)}
              >
                {allDangerousExcluded
                  ? t("scriptAnalysisIncludeDangerous")
                  : t("scriptAnalysisExcludeDangerous")}
              </Button>
            ) : undefined
          }
        >
          <chakra.div>{t("scriptAnalysisDangerBody")}</chakra.div>
          <chakra.div mt="1" fontFamily="mono" fontSize="xs">
            {kinds.map((k) => t(DANGER_LABELS[k.kind], { count: k.count.toLocaleString() })).join(" · ")}
          </chakra.div>
          {dangerUnlisted > 0 && (
            <chakra.div mt="1" fontSize="xs">
              {t("scriptAnalysisDangerOverflow", {
                shown: a.dangerous.length.toLocaleString(),
                rest: dangerUnlisted.toLocaleString(),
              })}
            </chakra.div>
          )}
        </Callout>
      )}

      {a.dangerous.length > 0 && (
        <StatementList
          items={a.dangerous}
          excluded={excluded}
          disabled={disabled}
          onToggle={onToggle}
          label={t("scriptAnalysisDangerTitle", { count: a.dangerousTotal.toLocaleString() })}
        />
      )}

      {a.txControlTotal > 0 && (
        <chakra.div color="app.textMuted" textStyle="caption">
          <chakra.span fontWeight={600} color="app.text">
            {t("scriptAnalysisTxTitle", { count: a.txControlTotal.toLocaleString() })}
          </chakra.span>{" "}
          <chakra.span fontFamily="mono">
            {txShown.map((m) => `${m.kind.toUpperCase()} #${m.index}`).join(", ")}
          </chakra.span>
          {a.txControlTotal > txShown.length && (
            <>
              {" "}
              {t("scriptAnalysisTxOverflow", { count: (a.txControlTotal - txShown.length).toLocaleString() })}
            </>
          )}
          <chakra.div>{t("scriptAnalysisTxLocked")}</chakra.div>
        </chakra.div>
      )}

      <chakra.div display="flex" flexDirection="column" gap="1">
        <FieldLabel as="div">
          {analysisIsTruncated(a)
            ? t("scriptAnalysisHeadLabel", {
                shown: a.head.length.toLocaleString(),
                total: a.totalStatements.toLocaleString(),
              })
            : t("scriptAnalysisHeadAll", { total: a.totalStatements.toLocaleString() })}
        </FieldLabel>
        <StatementList
          items={a.head}
          excluded={excluded}
          disabled={disabled}
          onToggle={onToggle}
          label={t("scriptAnalysisHeadAll", { total: a.totalStatements.toLocaleString() })}
        />
      </chakra.div>

      {excluded.size > 0 && (
        <chakra.span fontSize="xs" color="app.textWarning">
          {t("scriptAnalysisExcluded", { count: excluded.size.toLocaleString() })}
        </chakra.span>
      )}
    </chakra.section>
  );
}

function StatementList({
  items,
  excluded,
  disabled,
  onToggle,
  label,
}: {
  items: ScriptAnalyzedStatement[];
  excluded: ReadonlySet<number>;
  disabled: boolean;
  onToggle: (index: number) => void;
  label: string;
}) {
  const t = useT();
  return (
    <chakra.ul
      aria-label={label}
      listStyleType="none"
      m="0"
      p="0"
      maxH="200px"
      overflowY="auto"
      borderWidth="1px"
      borderColor="app.border"
      borderRadius="md"
    >
      {items.map((s) => {
        const skipped = excluded.has(s.index);
        return (
          <chakra.li
            key={s.index}
            display="flex"
            alignItems="flex-start"
            gap="2"
            px="2.5"
            py="1.5"
            borderBottomWidth="1px"
            borderColor="app.border"
          >
            <chakra.span mt="0.5" flex="none">
              <Checkbox
                checked={skipped}
                onChange={() => onToggle(s.index)}
                disabled={disabled || s.category === "txControl"}
                aria-label={t("scriptAnalysisSkipAria", { index: s.index })}
              />
            </chakra.span>
            <chakra.span display="flex" flexDirection="column" gap="0.5" minW={0} flex="1">
              <chakra.span
                fontFamily="mono"
                fontSize="xs"
                color="app.text"
                wordBreak="break-all"
                textDecoration={skipped ? "line-through" : "none"}
                opacity={skipped ? 0.6 : 1}
              >
                {s.sql}
              </chakra.span>
              <chakra.span color="app.textMuted" textStyle="caption" display="flex" flexWrap="wrap" gap="2">
                <span>{t("scriptStatementLine", { index: s.index, line: s.line })}</span>
                <span>{t(CATEGORY_LABELS[s.category])}</span>
                {s.danger && (
                  <chakra.span color="app.textError">{t(DANGER_KIND_LABELS[s.danger])}</chakra.span>
                )}
                {s.blocked && (
                  <chakra.span color="app.textWarning">{t("scriptStatementBlocked")}</chakra.span>
                )}
                {skipped && <span>{t("scriptAnalysisSkip")}</span>}
              </chakra.span>
            </chakra.span>
          </chakra.li>
        );
      })}
    </chakra.ul>
  );
}
