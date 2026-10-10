import { useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type ProcessInfo } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiAvailable } from "../ai/useAiAvailable";
import { useAiStream } from "../ai/useAiStream";
import { dialectLabel, ERROR_EXPLAIN_MAX_TABLES, needsSendScopeConfirm, resolveTableDatabase } from "../ai/errorExplain";
import { riskTone, type ImpactRisk } from "../ai/impactAnalysis";
import {
  buildLockDiagnosePrompt,
  buildLockDiagnoseSystem,
  lockDiagnoseTableRefs,
  LOCK_DIAGNOSE_FORMAT,
  parseLockDiagnoseResponse,
  selectLockDiagnoseTargets,
  toLockDiagnoseProcess,
  type LockDiagnoseResponse,
  type LockDiagnoseScope,
  type LockDiagnoseTable,
} from "../ai/lockDiagnose";
import { useLocale, useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { useSettings } from "../settings";
import { Button } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { Icon, ICON_SIZES } from "./Icon";
import { CodePreview, ErrorNote, FieldLabel } from "./modalForm";
import { AiStreamProgress } from "./AiStreamProgress";
import { AiUsageNote } from "./AiUsageNote";
import { Tooltip } from "./Tooltip";

type State =
  | { kind: "idle" }
  | { kind: "running"; sends: string }
  | { kind: "done"; sends: string; value: LockDiagnoseResponse }
  | { kind: "raw"; sends: string; raw: string }
  | { kind: "error"; sends: string; message: string; refused: boolean }
  | { kind: "cancelled"; sends: string };

export interface AiLockDiagnoseProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。SQLite はプロセス一覧が無いので何も描かない。 */
  driver: string;
  /** 一覧のプロセス (待機関係つき)。 */
  processes: readonly ProcessInfo[];
  /** 一覧で選択中のプロセス id。 */
  selectedIds: ReadonlySet<number>;
  /** 本番接続か。true のときは送信前に本番である旨の確認を出す。 */
  isProduction?: boolean;
  /** PostgreSQL で修飾の無いテーブルを引くスキーマ。省略時は `public`。 */
  schema?: string | null;
}

/**
 * プロセス一覧内の「ロック待ち / 長時間クエリを AI で解説」ボタンと結果パネル (#1478)。
 * 対象は 選択中 > 待機チェーン > 長時間実行クエリ の順で決まる。AI 無効 / キー未設定 /
 * SQLite のときは何も描かない。KILL は AI からは実行せず、提案は表示のみ
 * (停止は一覧の既存ボタンでユーザが行う)。
 */
export function AiLockDiagnose(props: AiLockDiagnoseProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const available = useAiAvailable();
  const { confirm, dialog } = useConfirm();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [open, setOpen] = useState(true);
  const stream = useAiStream({ idPrefix: "ai_lock" });
  const buttonRef = useRef<HTMLButtonElement>(null);

  const targets = useMemo(
    () => selectLockDiagnoseTargets(props.processes, props.selectedIds),
    [props.processes, props.selectedIds],
  );

  // 件数が分かる前 (ボタンのツールチップなど) は件数を出さず、上限つきの言い方にする。
  const sendsLine = (tableCount: number | null) =>
    t("lockDiagnoseSends", {
      sql: ai.maskLiterals ? t("dangerousAiSqlMasked") : t("dangerousAiSqlRaw"),
      dialect: dialectLabel(props.driver),
      tables:
        tableCount === null
          ? t("lockDiagnoseTablesUnknown", { max: ERROR_EXPLAIN_MAX_TABLES })
          : tableCount > 0
            ? t("dangerousAiTablesSome", { count: tableCount })
            : t("dangerousAiTablesNone"),
    });

  const run = async () => {
    if (!targets) return;
    // 二重クリックで 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await runInner(targets);
    } catch (e) {
      stream.release();
      setState({ kind: "error", sends: sendsLine(null), message: String(e), refused: false });
    }
  };

  const runInner = async (tg: NonNullable<typeof targets>) => {
    const abort = () => {
      stream.release();
    };
    buttonRef.current?.focus();
    // 一覧は 200 文字の要約しか持たないので、対象だけ全文を取り直す (取れなければ要約)。
    // 確認ダイアログに実際に引くテーブル数を出すため、確認より先に行う (読み取りのみ・送信なし)。
    const procs = await Promise.all(
      tg.processes.map(async (p) => {
        const full = p.query_summary
          ? await api.getProcessQuery(props.sessionId, p.id).catch(() => null)
          : null;
        return toLockDiagnoseProcess(p, full);
      }),
    );
    const refs = lockDiagnoseTableRefs(procs, props.driver, {
      connectedDatabase: props.processes.find((p) => p.is_self)?.database ?? null,
      schema: props.schema,
    });
    if (needsSendScopeConfirm(ai.sendScope)) {
      const ok = await confirm({
        title: t("lockDiagnoseScopeTitle"),
        message: `${t("lockDiagnoseScopeBody")}\n${sendsLine(refs.length)}`,
        confirmLabel: t("dangerousAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    if (props.isProduction) {
      const ok = await confirm({
        title: t("lockDiagnoseProdTitle"),
        message: `${t("lockDiagnoseProdBody")}\n${sendsLine(refs.length)}`,
        confirmLabel: t("dangerousAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) return abort();
    }
    setOpen(true);
    setState({ kind: "running", sends: sendsLine(refs.length) });

    // スキーマ情報はベストエフォート。取得できないものは黙って落とす。行データは取得しない。
    const fetched = await Promise.all(
      refs.map(async (ref): Promise<LockDiagnoseTable | null> => {
        const db = resolveTableDatabase(ref, null, props.driver);
        if (!db) return null;
        try {
          const [columns, estimatedRows] = await Promise.all([
            api.describeTable(props.sessionId, db, ref.table),
            api.tableRowEstimate(props.sessionId, db, ref.table).catch(() => null),
          ]);
          return { name: ref.table, columns, estimatedRows };
        } catch {
          return null;
        }
      }),
    );
    if (!stream.isMounted()) {
      stream.release();
      return;
    }
    const tables = fetched.filter((x): x is LockDiagnoseTable => x !== null);
    const sends = sendsLine(tables.length);
    setState({ kind: "running", sends });
    await stream.start(
      {
        task: "lockDiagnose",
        system: buildLockDiagnoseSystem(locale),
        prompt: buildLockDiagnosePrompt({
          driver: props.driver,
          scope: tg.scope,
          processes: procs,
          omitted: tg.omitted,
          tables,
          maskLiterals: ai.maskLiterals,
          locale,
        }),
        settings: toAiSnapshot(ai),
        format: LOCK_DIAGNOSE_FORMAT,
      },
      {
        parse: parseLockDiagnoseResponse,
        onDone: ({ parsed }) =>
          setState(
            parsed.ok
              ? { kind: "done", sends, value: parsed.value }
              : { kind: "raw", sends, raw: parsed.raw },
          ),
        onError: (f) => setState({ kind: "error", sends, message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled", sends }),
      },
    );
  };

  // SQLite にはプロセス一覧が無い (対象外)。AI 無効 / キー未設定のときも入口を出さない。
  if (props.driver === "sqlite" || !available) return null;
  const running = state.kind === "running";
  const hasResult = state.kind !== "idle" && state.kind !== "running";
  const scopeLabel: Record<LockDiagnoseScope, string> = {
    selection: t("lockDiagnoseScopeSelection"),
    chain: t("lockDiagnoseScopeChain"),
    longRunning: t("lockDiagnoseScopeLong"),
  };

  return (
    <Flex direction="column" gap="2" fontSize="sm" color="app.text" data-testid="ai-lock-diagnose">
      <Flex align="center" gap="2" wrap="wrap">
        <Tooltip label={targets ? sendsLine(null) : t("lockDiagnoseNoTarget")} focusableWrapper={!targets}>
          <Button
            ref={buttonRef}
            type="button"
            variant="secondary"
            aria-disabled={running || !targets}
            onClick={() => {
              void run();
            }}
          >
            <Icon name="sparkles" size={ICON_SIZES.sm} /> {t("lockDiagnoseButton")}
          </Button>
        </Tooltip>
        {targets && (
          <chakra.span color="app.textMuted" textStyle="caption" data-testid="ai-lock-scope">
            {t("lockDiagnoseTarget", { scope: scopeLabel[targets.scope], count: targets.processes.length })}
          </chakra.span>
        )}
        {running && (
          <Button type="button" variant="secondary" onClick={stream.cancel}>
            {t("dangerousAiStop")}
          </Button>
        )}
        {hasResult && (
          <Button
            type="button"
            variant="secondary"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? "chevron-down" : "chevron-right"} size={ICON_SIZES.sm} />
            {t("lockDiagnoseResultToggle")}
          </Button>
        )}
      </Flex>
      {running && (
        <AiStreamProgress stream={stream} fields={["summary"]} waitingLabel={t("dangerousAiRunning")} />
      )}
      {state.kind !== "idle" && (
        <chakra.span color="app.textMuted" textStyle="caption">
          {state.sends}
        </chakra.span>
      )}
      {(running || (hasResult && open)) && (
        <Flex direction="column" gap="2" maxH="320px" overflow="auto" aria-live="polite">
          {state.kind === "done" && <ResultView value={state.value} />}
          <AiUsageNote event={stream.done} />
          {state.kind === "raw" && (
            <Flex direction="column" gap="1">
              <ErrorNote role="alert">{t("dangerousAiParseError")}</ErrorNote>
              <CodePreview wrap maxH="160px">
                {state.raw}
              </CodePreview>
            </Flex>
          )}
          {state.kind === "error" &&
            (state.refused ? (
              <Callout tone="warning" role="alert">
                {t("dangerousAiRefused", { message: state.message })}
              </Callout>
            ) : (
              <ErrorNote role="alert">{t("dangerousAiError", { message: state.message })}</ErrorNote>
            ))}
          {state.kind === "cancelled" && (
            <Callout tone="info" role="status">
              {t("dangerousAiCancelled")}
            </Callout>
          )}
        </Flex>
      )}
      {/* AI は KILL を実行しない。停止は一覧の既存ボタンでユーザが行う。 */}
      {(running || hasResult) && (
        <Callout tone="info" role="note">
          {t("lockDiagnoseGuardNote")}
        </Callout>
      )}
      {dialog}
    </Flex>
  );
}

function ResultView({ value }: { value: LockDiagnoseResponse }) {
  const t = useT();
  const impactLabel: Record<ImpactRisk, string> = {
    high: t("lockDiagnoseImpactHigh"),
    medium: t("lockDiagnoseImpactMedium"),
    low: t("lockDiagnoseImpactLow"),
  };
  return (
    <>
      <chakra.span whiteSpace="pre-wrap">{value.summary}</chakra.span>
      {value.waits.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("lockDiagnoseWaits")}</FieldLabel>
          {value.waits.map((w, i) => (
            <Flex key={`${i}-${w.session_id}`} direction="column" gap="0.5">
              <chakra.span fontFamily="mono" fontWeight={600}>
                #{w.session_id}
                {w.waiting_for.length > 0 && (
                  <chakra.span fontWeight={400} color="app.textMuted">
                    {" → "}
                    {w.waiting_for.map((id) => `#${id}`).join(", ")}
                  </chakra.span>
                )}
              </chakra.span>
              <chakra.span color="app.textMuted">{w.detail}</chakra.span>
            </Flex>
          ))}
        </Flex>
      )}
      {value.stop_candidates.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("lockDiagnoseStopCandidates")}</FieldLabel>
          <chakra.span color="app.textMuted" textStyle="caption">
            {t("lockDiagnoseStopNote")}
          </chakra.span>
          {value.stop_candidates.map((c, i) => {
            const tone = riskTone(c.impact);
            return (
              <Flex key={`${i}-${c.session_id}`} align="baseline" gap="2" wrap="wrap">
                <chakra.span fontFamily="mono" fontWeight={600}>
                  #{c.session_id}
                </chakra.span>
                <chakra.span
                  px="2"
                  py="0.5"
                  borderRadius="pill"
                  border="1px solid"
                  borderColor={semanticColorToken(tone, "border")}
                  bg={semanticColorToken(tone, "subtle")}
                  color={semanticColorToken(tone, "text")}
                  fontWeight={600}
                  data-impact={c.impact}
                >
                  {t("lockDiagnoseImpact", { level: impactLabel[c.impact] })}
                </chakra.span>
                <chakra.span color="app.textMuted">{c.reason}</chakra.span>
              </Flex>
            );
          })}
        </Flex>
      )}
      {value.prevention.length > 0 && (
        <Flex direction="column" gap="1">
          <FieldLabel as="div">{t("lockDiagnosePrevention")}</FieldLabel>
          {value.prevention.map((r, i) => (
            <chakra.span key={`${i}-${r}`}>・{r}</chakra.span>
          ))}
        </Flex>
      )}
    </>
  );
}
