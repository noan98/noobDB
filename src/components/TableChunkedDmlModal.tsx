import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { useCountPreviews, parseCountCell } from "../useCountPreviews";
import {
  buildChunkSql,
  buildCountSql,
  MAX_BATCH_SIZE,
  maxBatchesFor,
  type ChunkedDmlErrorCode,
  type ChunkedOp,
} from "./chunkedDml";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Segmented } from "./Segmented";
import { Button, Input } from "./ui";

/**
 * 大規模 DML のチャンク分割実行ダイアログ (#2020)。
 *
 * 任意の 1 文を書き換えるのではなく、テーブル・操作 (DELETE / UPDATE の SET 句)・WHERE・
 * バッチサイズ・バッチ間ウェイトを指定させるガイド付き操作。1 バッチは Rust の
 * `run_chunked_dml_batch` (既存の `run_query_transaction` 経路) で実行し、ループ・進捗・
 * ウェイト・中断・最大バッチ数 (UPDATE の無限ループ対策) はここで持つ。
 * 開始前の確認 (本番ではテーブル名の入力確認) は呼び出し側 (App) の `onConfirmStart` が担う。
 */
interface Props {
  sessionId: string;
  driver: string;
  database: string;
  table: string;
  readOnly: boolean;
  /** 実行前の確認。false なら開始しない。 */
  onConfirmStart: (info: { table: string; operation: ChunkedOp; batchSize: number }) => Promise<boolean>;
  onClose: () => void;
}

type OpKind = "delete" | "update";
type Phase = "idle" | "running" | "done" | "cancelled" | "limit" | "error";

const DEFAULT_BATCH = 1000;

function parseInt10(text: string): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

export function TableChunkedDmlModal({
  sessionId,
  driver,
  database,
  table,
  readOnly,
  onConfirmStart,
  onClose,
}: Props) {
  const t = useT();
  const [kind, setKind] = useState<OpKind>("delete");
  const [setClause, setSetClause] = useState("");
  const [whereText, setWhereText] = useState("");
  const [batchText, setBatchText] = useState(String(DEFAULT_BATCH));
  const [waitText, setWaitText] = useState("0");
  const [phase, setPhase] = useState<Phase>("idle");
  const [batches, setBatches] = useState(0);
  const [affected, setAffected] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [limit, setLimit] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const whereRef = useRef<HTMLInputElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // 閉じられたら (アンマウント) ループを止める。実行済みのバッチは確定している。
  useEffect(
    () => () => {
      cancelRef.current = true;
    },
    [],
  );

  const batchSize = parseInt10(batchText);
  const waitMs = parseInt10(waitText);
  const op: ChunkedOp = useMemo(
    () => (kind === "delete" ? { kind: "delete" } : { kind: "update", setClause }),
    [kind, setClause],
  );
  const dbArg = driver === "sqlite" ? null : database;

  const built = useMemo(
    () => buildChunkSql({ driver, database: dbArg, table, op, where: whereText, batchSize }),
    [driver, dbArg, table, op, whereText, batchSize],
  );
  const countBuilt = useMemo(
    () => buildCountSql({ driver, database: dbArg, table, where: whereText }),
    [driver, dbArg, table, whereText],
  );
  const waitValid = Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 600_000;

  const runCount = useMemo(
    () => (sql: string) => api.runLookupQuery({ sessionId, sql, database: dbArg, rowCap: 1 }),
    [sessionId, dbArg],
  );
  const countItems = useMemo(
    () => (countBuilt.ok ? [{ id: "target", sql: countBuilt.sql }] : []),
    [countBuilt],
  );
  const countState = useCountPreviews(runCount, countItems, phase === "idle").target;

  // 入力が空のうちはエラーを出さず、入力が始まってから理由を見せる。
  const errorCode: ChunkedDmlErrorCode | null = built.ok ? null : built.code;
  const showError = errorCode !== null && !(errorCode === "emptyWhere" && whereText.trim() === "");
  const running = phase === "running";
  const canRun = built.ok && waitValid && !readOnly && !running;

  const start = async () => {
    if (!canRun) return;
    const ok = await onConfirmStart({ table, operation: op, batchSize });
    if (!ok) return;
    cancelRef.current = false;
    setPhase("running");
    setBatches(0);
    setAffected(0);
    setTotal(null);
    setError(null);
    let done = 0;
    let sum = 0;
    try {
      if (!countBuilt.ok) return;
      const counted = await api.runLookupQuery({
        sessionId,
        sql: countBuilt.sql,
        database: dbArg,
        rowCap: 1,
      });
      const rows = parseCountCell(counted.rows[0]?.[0]);
      if (rows === null) throw new Error("count");
      setTotal(rows);
      if (rows === 0) {
        setPhase("done");
        return;
      }
      const cap = maxBatchesFor(rows, batchSize);
      setLimit(cap);
      for (;;) {
        if (cancelRef.current) {
          setPhase("cancelled");
          return;
        }
        if (done >= cap) {
          setPhase("limit");
          return;
        }
        const res = await api.runChunkedDmlBatch({
          sessionId,
          database: dbArg,
          table,
          operation: op,
          whereClause: whereText,
          batchSize,
        });
        const n = Number(res.rows_affected ?? 0);
        done += 1;
        sum += n;
        setBatches(done);
        setAffected(sum);
        if (n === 0) {
          setPhase("done");
          return;
        }
        // バッチ間ウェイト。中断を素早く拾うため細切れに待つ。
        for (let waited = 0; waited < waitMs && !cancelRef.current; waited += 100) {
          await new Promise((r) => setTimeout(r, Math.min(100, waitMs - waited)));
        }
      }
    } catch (e) {
      setError(String(e));
      setPhase("error");
    } finally {
      // 失敗時に進捗を見せるため、最後の値を反映する。
      setBatches(done);
      setAffected(sum);
    }
  };

  const stop = () => {
    cancelRef.current = true;
  };

  const progress = t("chunkedDmlProgress", {
    batches,
    rows: affected,
    total: total !== null ? t("chunkedDmlProgressTotal", { rows: total }) : "",
  });

  return (
    <Modal
      // no-submit: 破壊的な書き込み。Enter / Cmd+Enter で誤って開始させず、キャンセルが既定
      width="640px"
      onClose={onClose}
      initialFocusEl={() => cancelBtnRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("chunkedDmlClose")}>
        {t("chunkedDmlTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.p textStyle="caption">{t("chunkedDmlIntro")}</chakra.p>
        {readOnly && <Callout tone="warning">{t("chunkedDmlReadOnly")}</Callout>}

        <FormSection>
          <FieldLabel as="div">{t("chunkedDmlOperation")}</FieldLabel>
          <Segmented
            ariaLabel={t("chunkedDmlOperation")}
            value={kind}
            onChange={(v) => !running && setKind(v)}
            options={[
              { value: "delete", label: t("chunkedDmlOpDelete") },
              { value: "update", label: t("chunkedDmlOpUpdate") },
            ]}
          />
        </FormSection>

        {kind === "update" && (
          <FormSection>
            <FieldLabel htmlFor="chunked-dml-set">{t("chunkedDmlSet")}</FieldLabel>
            <Input
              id="chunked-dml-set"
              value={setClause}
              disabled={running}
              placeholder={t("chunkedDmlSetPlaceholder")}
              onChange={(e) => setSetClause(e.target.value)}
              fontFamily="mono"
            />
            <Callout tone="warning">{t("chunkedDmlUpdateWarning")}</Callout>
          </FormSection>
        )}

        <FormSection>
          <FieldLabel htmlFor="chunked-dml-where">{t("chunkedDmlWhere")}</FieldLabel>
          <Input
            id="chunked-dml-where"
            ref={whereRef}
            value={whereText}
            disabled={running}
            placeholder={t("chunkedDmlWherePlaceholder")}
            onChange={(e) => setWhereText(e.target.value)}
            fontFamily="mono"
          />
          {showError && errorCode && <FieldError>{t(`chunkedDmlErr_${errorCode}` as I18nKey)}</FieldError>}
          {countBuilt.ok && phase === "idle" && countState && (
            <chakra.span textStyle="caption">
              {countState.status === "ok"
                ? t("chunkedDmlRowsMatching", { rows: countState.count })
                : countState.status === "error"
                  ? t("chunkedDmlRowsError", { error: countState.error })
                  : t("chunkedDmlRowsCounting")}
            </chakra.span>
          )}
        </FormSection>

        <chakra.div display="flex" gap="4" flexWrap="wrap">
          <FormSection flex="1" minW="0">
            <FieldLabel htmlFor="chunked-dml-size">{t("chunkedDmlBatchSize")}</FieldLabel>
            <Input
              id="chunked-dml-size"
              inputMode="numeric"
              value={batchText}
              disabled={running}
              onChange={(e) => setBatchText(e.target.value)}
              fontFamily="mono"
            />
            {!(batchSize >= 1 && batchSize <= MAX_BATCH_SIZE) && (
              <FieldError>{t("chunkedDmlErr_badBatchSize")}</FieldError>
            )}
          </FormSection>
          <FormSection flex="1" minW="0">
            <FieldLabel htmlFor="chunked-dml-wait">{t("chunkedDmlWait")}</FieldLabel>
            <Input
              id="chunked-dml-wait"
              inputMode="numeric"
              value={waitText}
              disabled={running}
              onChange={(e) => setWaitText(e.target.value)}
              fontFamily="mono"
            />
          </FormSection>
        </chakra.div>

        <FormSection>
          <FieldLabel as="div">{t("chunkedDmlPreview")}</FieldLabel>
          <CodePreview minH="80px" wrap>
            {built.ok ? built.sql : t("chunkedDmlPreviewEmpty")}
          </CodePreview>
        </FormSection>

        {phase !== "idle" && (
          <chakra.div role="status" aria-live="polite" display="flex" flexDirection="column" gap="2">
            {phase === "running" && <chakra.span>{progress}</chakra.span>}
            {phase === "done" &&
              (total === 0 ? (
                <Callout tone="info">{t("chunkedDmlNothing")}</Callout>
              ) : (
                <Callout tone="success">{t("chunkedDmlDone", { batches, rows: affected })}</Callout>
              ))}
            {phase === "cancelled" && (
              <Callout tone="warning">{t("chunkedDmlCancelled", { batches, rows: affected })}</Callout>
            )}
            {phase === "limit" && (
              <Callout tone="warning">{t("chunkedDmlLimitReached", { limit, rows: affected })}</Callout>
            )}
            {phase === "error" && (
              <ErrorNote>{t("chunkedDmlFailed", { batches, rows: affected, error: error ?? "" })}</ErrorNote>
            )}
          </chakra.div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="dangerOutline" disabled={!canRun} onClick={() => void start()}>
          {t("chunkedDmlRun")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button ref={cancelBtnRef} type="button" variant="primary" onClick={running ? stop : onClose}>
          {running ? t("chunkedDmlStop") : t("chunkedDmlClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
