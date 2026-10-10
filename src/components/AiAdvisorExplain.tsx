import { useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type HealthFinding, type IndexInfo } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import { needsSendScopeConfirm } from "../ai/errorExplain";
import {
  ADVISOR_EXPLAIN_FORMAT,
  advisorRelatedTables,
  buildAdvisorExplainPrompt,
  buildAdvisorExplainSystem,
  parseAdvisorExplainResponse,
  verdictTone,
  type AdvisorExplainResponse,
  type AdvisorExplainTable,
  type AdvisorVerdict,
} from "../ai/advisorExplain";
import { dialectLabel } from "../ai/errorExplain";
import { useLocale, useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { useSettings } from "../settings";
import { Button } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";
import { Tooltip } from "./Tooltip";

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; value: AdvisorExplainResponse }
  | { kind: "raw"; raw: string }
  | { kind: "error"; message: string; refused: boolean }
  | { kind: "cancelled" };

export interface AiAdvisorExplainProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  database: string;
  finding: HealthFinding;
}

/**
 * スキーマ健全性アドバイザの各指摘に出す「AI に聞く」ボタンと解説領域 (#1468)。
 * 解説は Bottom Panel の行内に展開し、モーダルにはしない。AI 無効 (設定オフ) のときは
 * 何も描かない (API キーの有無は親の `AdvisorPanel` が 1 回だけ確認して渡す)。
 * AI は説明を返すだけで SQL は実行しない (実行は従来どおりエディタへ挿入 → 利用者が行う)。
 */
export function AiAdvisorExplain(props: AiAdvisorExplainProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const [state, setState] = useState<State>({ kind: "idle" });
  const stream = useAiStream({ idPrefix: "ai_advisor" });
  const buttonRef = useRef<HTMLButtonElement>(null);

  const tableNames = useMemo(() => advisorRelatedTables(props.finding), [props.finding]);
  const sends = t("advisorAiSends", {
    ddl: props.finding.fix_ddl
      ? ai.maskLiterals
        ? t("advisorAiDdlMasked")
        : t("advisorAiDdlRaw")
      : t("advisorAiDdlNone"),
    dialect: dialectLabel(props.driver),
    tables: String(tableNames.length),
  });

  const run = async () => {
    // 二重クリックで 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await runInner();
    } catch (e) {
      stream.release();
      setState({ kind: "error", message: String(e), refused: false });
    }
  };

  const runInner = async () => {
    buttonRef.current?.focus();
    // 送信範囲が「スキーマ情報のみ」のときは、指摘と修正 DDL を送ってよいか確認する。
    if (needsSendScopeConfirm(ai.sendScope)) {
      const ok = await confirm({
        title: t("advisorAiScopeTitle"),
        message: `${t("advisorAiScopeBody")}\n${sends}`,
        confirmLabel: t("advisorAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) {
        stream.release();
        return;
      }
    }
    setState({ kind: "running" });
    // スキーマ定義はベストエフォート。取得できないものは黙って落とす。行データは取得しない。
    const fetched = await Promise.all(
      tableNames.map(async (name): Promise<AdvisorExplainTable | null> => {
        try {
          const [columns, indexes] = await Promise.all([
            api.describeTable(props.sessionId, props.database, name),
            api.listIndexes(props.sessionId, props.database, name).catch(() => [] as IndexInfo[]),
          ]);
          return { name, columns, indexes };
        } catch {
          return null;
        }
      }),
    );
    // スキーマ取得中にアンマウントされたら、要求を出さずに終える。
    if (!stream.isMounted()) {
      stream.release();
      return;
    }
    const tables = fetched.filter((x): x is AdvisorExplainTable => x !== null);
    await stream.start(
      {
        task: "advisorExplain",
        system: buildAdvisorExplainSystem(locale),
        prompt: buildAdvisorExplainPrompt({
          driver: props.driver,
          finding: props.finding,
          tables,
          maskLiterals: ai.maskLiterals,
        }),
        settings: toAiSnapshot(ai),
        format: ADVISOR_EXPLAIN_FORMAT,
      },
      {
        parse: parseAdvisorExplainResponse,
        onDone: ({ parsed }) =>
          setState(parsed.ok ? { kind: "done", value: parsed.value } : { kind: "raw", raw: parsed.raw }),
        onError: (f) => setState({ kind: "error", message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled" }),
      },
    );
  };

  if (!ai.enabled) return null;
  const running = state.kind === "running";

  return (
    <Flex direction="column" gap="2" marginTop="2" data-testid="ai-advisor-explain">
      <Flex align="center" gap="2" wrap="wrap">
        <Tooltip label={sends}>
          <Button
            ref={buttonRef}
            type="button"
            variant="secondary"
            size="sm"
            // disabled にするとフォーカスを戻せないので aria-disabled のみ (二重実行は useAiStream の acquire が弾く)。
            aria-disabled={running}
            onClick={() => {
              void run();
            }}
          >
            {t("advisorAiButton")}
          </Button>
        </Tooltip>
        {running && (
          <Button type="button" variant="secondary" size="sm" onClick={stream.cancel}>
            {t("advisorAiStop")}
          </Button>
        )}
      </Flex>
      {running && (
        <AiStreamProgress stream={stream} fields={["why"]} waitingLabel={t("advisorAiRunning")} />
      )}
      {state.kind !== "idle" && state.kind !== "running" && (
        <Flex direction="column" gap="2" aria-live="polite">
          {state.kind === "done" && <ResultView value={state.value} />}
          {state.kind === "raw" && (
            <Flex direction="column" gap="1">
              <ErrorNote role="alert">{t("advisorAiParseError")}</ErrorNote>
              <CodePreview wrap maxH="160px">
                {state.raw}
              </CodePreview>
            </Flex>
          )}
          {state.kind === "error" &&
            (state.refused ? (
              <Callout tone="warning" role="alert">
                {t("advisorAiRefused", { message: state.message })}
              </Callout>
            ) : (
              <ErrorNote role="alert">{t("advisorAiError", { message: state.message })}</ErrorNote>
            ))}
          {state.kind === "cancelled" && (
            <Callout tone="info" role="status">
              {t("advisorAiCancelled")}
            </Callout>
          )}
          {/* 強制レベルの明示: AI は説明するだけで、SQL の実行は利用者が行う。 */}
          <Callout tone="info" role="note">
            {t("advisorAiGuardNote")}
          </Callout>
        </Flex>
      )}
      {dialog}
    </Flex>
  );
}

function ResultView({ value }: { value: AdvisorExplainResponse }) {
  const t = useT();
  const tone = verdictTone(value.fix_verdict);
  const verdictLabel: Record<AdvisorVerdict, string> = {
    safe: t("advisorAiVerdictSafe"),
    caution: t("advisorAiVerdictCaution"),
    avoid: t("advisorAiVerdictAvoid"),
    no_fix: t("advisorAiVerdictNoFix"),
  };
  return (
    <>
      <Flex direction="column" gap="1">
        <FieldLabel as="div">{t("advisorAiWhy")}</FieldLabel>
        <chakra.span whiteSpace="pre-wrap">{value.why}</chakra.span>
      </Flex>
      <Flex direction="column" gap="1">
        <FieldLabel as="div">{t("advisorAiConsequence")}</FieldLabel>
        <chakra.span whiteSpace="pre-wrap">{value.consequence}</chakra.span>
      </Flex>
      <Flex direction="column" gap="1">
        <Flex align="center" gap="2">
          <FieldLabel as="div">{t("advisorAiFix")}</FieldLabel>
          <chakra.span
            px="2"
            py="0.5"
            borderRadius="pill"
            border="1px solid"
            borderColor={semanticColorToken(tone, "border")}
            bg={semanticColorToken(tone, "subtle")}
            color={semanticColorToken(tone, "text")}
            fontWeight={600}
            data-verdict={value.fix_verdict}
          >
            {verdictLabel[value.fix_verdict]}
          </chakra.span>
        </Flex>
        <chakra.span whiteSpace="pre-wrap">{value.fix_advice}</chakra.span>
      </Flex>
      {value.cautions.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("advisorAiCautions")}</FieldLabel>
          {value.cautions.map((c, i) => (
            <chakra.span key={`${i}-${c}`}>・{c}</chakra.span>
          ))}
        </Flex>
      )}
    </>
  );
}
