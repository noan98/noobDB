import { useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import {
  buildErrorExplainPrompt,
  buildErrorExplainSystem,
  dialectLabel,
  ERROR_EXPLAIN_FORMAT,
  extractTableRefs,
  needsSendScopeConfirm,
  resolveTableDatabase,
  parseErrorExplainResponse,
  type ErrorExplainResponse,
  type ExplainTable,
} from "../ai/errorExplain";
import { useLocale, useT } from "../i18n";
import { useSettings } from "../settings";
import { Button } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";
import { Tooltip } from "./Tooltip";

type State =
  | { kind: "idle" }
  | { kind: "running"; sends: string }
  | { kind: "done"; sends: string; value: ErrorExplainResponse; masked: boolean }
  | { kind: "raw"; sends: string; raw: string }
  | { kind: "error"; sends: string; message: string; refused: boolean }
  | { kind: "cancelled"; sends: string };

export interface AiErrorExplainProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  isProduction: boolean;
  errorKind: string | null;
  message: string;
  sql: string;
  /** 失敗した実行のデータベース (テーブル定義の引き先)。 */
  database: string | null;
  /**
   * 修正 SQL 案を失敗したタブのエディタへ反映する (実行はしない)。
   * `closed` = タブが既に無い / `cancelled` = 全文置換の確認で取り消された。
   */
  onApply: (sql: string) => Promise<"applied" | "cancelled" | "closed">;
}

/**
 * エラー表示の直下に置く「AI に解説してもらう」ボタンと結果パネル (#692)。
 * AI 無効 (設定オフ / API キー未設定) のときは何も描かない。静的な errorHints の有無には
 * 依存しない。修正 SQL は「エディタに反映」を押したときだけ差し替え、自動実行はしない。
 * 親は `key` にエラーの識別子を渡して、別のエラーでは状態を作り直すこと。
 */
export function AiErrorExplain(props: AiErrorExplainProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const [hasKey, setHasKey] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [applied, setApplied] = useState<null | "applied" | "closed">(null);
  const stream = useAiStream({ idPrefix: "ai_err" });

  useEffect(() => {
    let alive = true;
    api
      .hasAiApiKey()
      .then((v) => {
        if (alive) setHasKey(v);
      })
      .catch(() => {
        /* 取得できなければ非表示のまま */
      });
    return () => {
      alive = false;
    };
  }, []);

  const tableRefs = useMemo(() => extractTableRefs(props.sql, props.driver), [props.sql, props.driver]);
  const sendsLine = (tableCount: number) =>
    t("aiErrorExplainSends", {
      sql: ai.maskLiterals ? t("aiErrorExplainSqlMasked") : t("aiErrorExplainSqlRaw"),
      dialect: dialectLabel(props.driver),
      tables:
        tableCount > 0 ? t("aiErrorExplainTablesSome", { count: tableCount }) : t("aiErrorExplainTablesNone"),
    });

  const run = async () => {
    // 二重クリックで 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await runInner();
    } catch (e) {
      stream.release();
      setState({ kind: "error", sends: "", message: String(e), refused: false });
    }
  };

  const runInner = async () => {
    // 確保した実行権はストリームの終了までフックが保持する。送信前に取りやめた場合は戻す。
    const abort = () => {
      stream.release();
    };
    if (needsSendScopeConfirm(ai.sendScope)) {
      const ok = await confirm({
        title: t("aiErrorExplainScopeTitle"),
        message: `${t("aiErrorExplainScopeBody")}\n${sendsLine(tableRefs.length)}`,
        confirmLabel: t("aiErrorExplainConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    if (props.isProduction) {
      const ok = await confirm({
        title: t("aiErrorExplainConfirmTitle"),
        message: `${t("aiErrorExplainConfirmBody")}\n${sendsLine(tableRefs.length)}`,
        confirmLabel: t("aiErrorExplainConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    setApplied(null);
    // テーブル定義はベストエフォート。取得できないテーブルは黙って落とす。
    const fetched = await Promise.all(
      tableRefs.map(async (ref): Promise<ExplainTable | null> => {
        const db = resolveTableDatabase(ref, props.database, props.driver);
        if (!db) return null;
        try {
          const columns = await api.describeTable(props.sessionId, db, ref.table);
          return { name: ref.table, columns };
        } catch {
          return null;
        }
      }),
    );
    const tables = fetched.filter((x): x is ExplainTable => x !== null);
    const sends = sendsLine(tables.length);
    setState({ kind: "running", sends });
    await stream.start(
      {
        task: "errorExplain",
        system: buildErrorExplainSystem(locale),
        prompt: buildErrorExplainPrompt({
          errorKind: props.errorKind,
          message: props.message,
          sql: props.sql,
          driver: props.driver,
          tables,
          maskLiterals: ai.maskLiterals,
          locale,
        }),
        settings: toAiSnapshot(ai),
        format: ERROR_EXPLAIN_FORMAT,
      },
      {
        parse: parseErrorExplainResponse,
        onDone: ({ parsed }) =>
          setState(
            parsed.ok
              ? { kind: "done", sends, value: parsed.value, masked: ai.maskLiterals }
              : { kind: "raw", sends, raw: parsed.raw },
          ),
        onError: (f) => setState({ kind: "error", sends, message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled", sends }),
      },
    );
  };

  if (!ai.enabled || !hasKey) return null;
  const running = state.kind === "running";

  return (
    <Flex
      direction="column"
      gap="2"
      px="3.5"
      py="2"
      bg="app.surface"
      borderTopWidth="1px"
      borderTopColor="app.border"
      fontSize="sm"
      color="app.text"
      data-testid="ai-error-explain"
    >
      <Flex align="center" gap="2" wrap="wrap">
        <Tooltip label={sendsLine(tableRefs.length)}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={running}
            onClick={() => {
              void run();
            }}
          >
            {t("aiErrorExplainButton")}
          </Button>
        </Tooltip>
        {running && (
          <Button type="button" variant="secondary" size="sm" onClick={stream.cancel}>
            {t("aiErrorExplainCancel")}
          </Button>
        )}
      </Flex>
      {running && (
        <AiStreamProgress stream={stream} fields={["explanation"]} waitingLabel={t("aiErrorExplainRunning")} />
      )}
      {state.kind !== "idle" && (
        <chakra.span color="app.textMuted" fontSize="xs">
          {state.sends}
        </chakra.span>
      )}
      {state.kind === "done" && (
        <Flex direction="column" gap="2" aria-live="polite" maxH="320px" overflow="auto">
          <Section label={t("aiErrorExplainExplanation")}>{state.value.explanation}</Section>
          <Section label={t("aiErrorExplainCause")}>{state.value.cause}</Section>
          {state.value.suggestedSql && (
            <Flex direction="column" gap="1">
              <FieldLabel as="div">{t("aiErrorExplainSuggested")}</FieldLabel>
              {state.masked && (
                <Callout tone="warning" role="status">
                  {t("aiErrorExplainMaskedNote")}
                </Callout>
              )}
              <CodePreview wrap maxH="160px">
                {state.value.suggestedSql}
              </CodePreview>
              <Flex align="center" gap="2">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    void props.onApply(state.value.suggestedSql ?? "").then((r) => {
                      if (r === "applied" || r === "closed") setApplied(r);
                    });
                  }}
                >
                  {t("aiErrorExplainApply")}
                </Button>
                {applied === "applied" && (
                  <chakra.span color="app.textSuccess" role="status">
                    {t("aiErrorExplainApplied")}
                  </chakra.span>
                )}
                {applied === "closed" && (
                  <chakra.span color="app.textWarning" role="status">
                    {t("aiErrorExplainTabClosed")}
                  </chakra.span>
                )}
              </Flex>
            </Flex>
          )}
          {state.value.notes.length > 0 && (
            <Callout tone="warning" title={t("aiErrorExplainNotes")} role="status">
              {state.value.notes.map((n, i) => (
                <chakra.div key={`${i}-${n}`}>{n}</chakra.div>
              ))}
            </Callout>
          )}
        </Flex>
      )}
      {state.kind === "raw" && (
        <Flex direction="column" gap="1">
          <ErrorNote role="alert">{t("aiErrorExplainParseError")}</ErrorNote>
          <CodePreview wrap maxH="160px">
            {state.raw}
          </CodePreview>
        </Flex>
      )}
      {state.kind === "error" &&
        (state.refused ? (
          <Callout tone="warning" role="alert">
            {t("aiErrorExplainRefused", { message: state.message })}
          </Callout>
        ) : (
          <ErrorNote role="alert">{t("aiErrorExplainError", { message: state.message })}</ErrorNote>
        ))}
      {state.kind === "cancelled" && (
        <Callout tone="info" role="status">
          {t("aiErrorExplainCancelled")}
        </Callout>
      )}
      {dialog}
    </Flex>
  );
}

function Section({ label, children }: { label: string; children: string }) {
  return (
    <Flex direction="column" gap="0.5">
      <FieldLabel as="div">{label}</FieldLabel>
      <chakra.span whiteSpace="pre-wrap">{children}</chakra.span>
    </Flex>
  );
}
