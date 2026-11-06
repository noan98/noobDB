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
  pickSqliteRowKey,
  type ChunkedDmlErrorCode,
  type ChunkedOp,
} from "./chunkedDml";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Segmented } from "./Segmented";
import { DeterminateProgressBar } from "./StreamProgressBar";
import { StatTile } from "./StatTile";
import { Button, Input } from "./ui";
import { estimateEtaMs, formatDuration, progressRatio, waitSecondsLeft } from "../progressEta";
import type { SemanticRole } from "../semanticColors";

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
  /** 本番プロファイル。対象件数の COUNT は自動ではなく手動ボタンにする (重い COUNT を勝手に撃たない)。 */
  isProduction: boolean;
  /** フライトレコーダ有効。各バッチを記録経路へ流す。 */
  capture: { retentionDays: number | null } | null;
  /** 実行前の確認。false なら開始しない。 */
  onConfirmStart: (info: {
    table: string;
    operation: ChunkedOp;
    batchSize: number;
    total: number;
    sql: string;
  }) => Promise<boolean>;
  onClose: () => void;
}

type OpKind = "delete" | "update";
type Phase = "idle" | "running" | "done" | "cancelled" | "limit" | "error" | "stalled";

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
  isProduction,
  capture,
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
  const [remaining, setRemaining] = useState<number | null>(null);
  const [captureNote, setCaptureNote] = useState<string | null>(null);
  const [recordedBatches, setRecordedBatches] = useState(0);
  const [manualCount, setManualCount] = useState<
    { status: "loading" } | { status: "ok"; count: number } | { status: "error"; error: string } | null
  >(null);
  // 経過時間・ETA・スロットル待機カウントダウン用 (#2092)。実行中だけ 250ms ごとに時計を進める。
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const cancelRef = useRef(false);
  // 開始準備 (件数の COUNT と確認ダイアログ) の間も二重起動させない。閉じられたら準備後に打ち切る。
  const startingRef = useRef(false);
  const unmountedRef = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const whereRef = useRef<HTMLInputElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // 閉じられたら (アンマウント) ループを止める。実行済みのバッチは確定している。
  useEffect(
    () => () => {
      cancelRef.current = true;
      unmountedRef.current = true;
    },
    [],
  );

  const isRunningPhase = phase === "running";
  useEffect(() => {
    if (!isRunningPhase) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [isRunningPhase]);
  // 終了した瞬間に経過時間を止める。
  useEffect(() => {
    if (phase === "idle" || phase === "running") return;
    setEndedAt((v) => v ?? Date.now());
  }, [phase]);

  const batchSize = parseInt10(batchText);
  const waitMs = parseInt10(waitText);
  const op: ChunkedOp = useMemo(
    () => (kind === "delete" ? { kind: "delete" } : { kind: "update", setClause }),
    [kind, setClause],
  );
  const dbArg = driver === "sqlite" ? null : database;

  // SQLite: 実行時 (Rust) と同じ行の別名をプレビューにも使う (rowid が実列に隠された表は _rowid_ / oid)。
  const [rowKey, setRowKey] = useState("rowid");
  useEffect(() => {
    if (driver !== "sqlite") return;
    let cancelled = false;
    Promise.resolve()
      .then(() => api.describeTable(sessionId, database, table))
      .then((cols) => {
        if (!cancelled) setRowKey(pickSqliteRowKey(cols.map((c) => c.name)) ?? "rowid");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [driver, sessionId, database, table]);
  const built = useMemo(
    () => buildChunkSql({ driver, database: dbArg, table, op, where: whereText, batchSize, rowKey }),
    [driver, dbArg, table, op, whereText, batchSize, rowKey],
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
  const autoCount = useCountPreviews(runCount, countItems, phase === "idle" && !isProduction).target;
  const countState = isProduction ? manualCount : autoCount;
  // 条件を変えたら手動の件数は古くなる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 入力が変わったら捨てる
  useEffect(() => setManualCount(null), [whereText, table]);

  // 入力が空のうちはエラーを出さず、入力が始まってから理由を見せる。
  const errorCode: ChunkedDmlErrorCode | null = built.ok ? null : built.code;
  const showError = errorCode !== null && !(errorCode === "emptyWhere" && whereText.trim() === "");
  const running = phase === "running";
  const canRun = built.ok && waitValid && !readOnly && !running && !preparing;

  const start = async () => {
    if (!canRun || !built.ok || !countBuilt.ok || startingRef.current) return;
    startingRef.current = true;
    setPreparing(true);
    try {
      await prepareAndRun();
    } finally {
      startingRef.current = false;
      if (!unmountedRef.current) setPreparing(false);
    }
  };

  const prepareAndRun = async () => {
    if (!built.ok || !countBuilt.ok) return;
    setBatches(0);
    setAffected(0);
    setTotal(null);
    setError(null);
    setRemaining(null);
    setCaptureNote(null);
    setRecordedBatches(0);
    setStartedAt(null);
    setEndedAt(null);
    setWaitUntil(null);
    let done = 0;
    let sum = 0;
    const countRows = async (): Promise<number> => {
      if (!countBuilt.ok) throw new Error("count");
      const r = await api.runLookupQuery({ sessionId, sql: countBuilt.sql, database: dbArg, rowCap: 1 });
      const n = parseCountCell(r.rows[0]?.[0]);
      if (n === null) throw new Error("count");
      return n;
    };
    let rows: number;
    try {
      rows = await countRows();
    } catch (e) {
      if (unmountedRef.current) return;
      setError(String(e));
      setPhase("error");
      return;
    }
    if (unmountedRef.current) return;
    const ok = await onConfirmStart({ table, operation: op, batchSize, total: rows, sql: built.sql });
    if (!ok || unmountedRef.current) return;
    cancelRef.current = false;
    setPhase("running");
    setStartedAt(Date.now());
    setTotal(rows);
    try {
      if (rows === 0) {
        setPhase("done");
        return;
      }
      const cap = maxBatchesFor(rows, batchSize);
      setLimit(cap);
      let prevCount = rows;
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
          capture,
        });
        const n = Number(res.rows_affected ?? 0);
        done += 1;
        sum += n;
        setBatches(done);
        setAffected(sum);
        if (res.recorded) setRecordedBatches((c) => c + 1);
        if (res.capture_note) setCaptureNote(res.capture_note);
        // UPDATE の暴走対策: 最初のバッチの後に件数を数え直し、更新した分だけ減っていなければ止める
        // (WHERE が更新後も真のままだと同じ行を更新し続ける)。
        if (kind === "update" && done === 1 && n > 0) {
          const now = await countRows();
          if (now > prevCount - n) {
            setRemaining(now);
            setPhase("stalled");
            return;
          }
          prevCount = now;
        }
        // DELETE は影響行数がバッチサイズ未満なら対象が尽きた。UPDATE は 0 行まで続ける。
        if (n === 0 || (kind === "delete" && n < batchSize)) {
          // 終了時にも数え直し、残りがあれば警告する。
          const left = await countRows();
          setRemaining(left);
          setPhase("done");
          return;
        }
        // バッチ間ウェイト。中断を素早く拾うため細切れに待つ。
        if (waitMs > 0) {
          // now も同時に進める (古い now のままだと切り上げで 1 秒多く出る)。
          const t0 = Date.now();
          setNow(t0);
          setWaitUntil(t0 + waitMs);
        }
        for (let waited = 0; waited < waitMs && !cancelRef.current; waited += 100) {
          await new Promise((r) => setTimeout(r, Math.min(100, waitMs - waited)));
        }
        setWaitUntil(null);
      }
    } catch (e) {
      setError(String(e));
      setPhase("error");
    } finally {
      setWaitUntil(null);
      setBatches(done);
      setAffected(sum);
    }
  };

  const stop = () => {
    cancelRef.current = true;
  };
  // 実行中は × / Esc / 背景クリックで閉じず、中断として扱う (実行済みバッチは確定済み)。
  const guardedClose = () => (running ? stop() : onClose());

  const countNow = async () => {
    if (!countBuilt.ok) return;
    setManualCount({ status: "loading" });
    try {
      const r = await api.runLookupQuery({ sessionId, sql: countBuilt.sql, database: dbArg, rowCap: 1 });
      const n = parseCountCell(r.rows[0]?.[0]);
      setManualCount(n === null ? { status: "error", error: "?" } : { status: "ok", count: n });
    } catch (e) {
      setManualCount({ status: "error", error: String(e) });
    }
  };

  // 進捗バー / StatTile の値 (#2092)。終了後は endedAt で時計を止める。
  const elapsedMs = startedAt === null ? 0 : Math.max(0, (endedAt ?? now) - startedAt);
  const fullyDone = phase === "done" && total !== null && total > 0 && (remaining ?? 0) === 0;
  const ratio = fullyDone ? 1 : progressRatio(affected, total);
  const etaMs = running ? estimateEtaMs(affected, total, elapsedMs) : null;
  const waitLeft = running ? waitSecondsLeft(waitUntil, now) : null;
  const barTone: SemanticRole | undefined =
    phase === "done"
      ? fullyDone
        ? "success"
        : "warning"
      : phase === "cancelled" || phase === "limit"
        ? "warning"
        : phase === "stalled" || phase === "error"
          ? "danger"
          : undefined;
  const remainingEstimate =
    total === null ? null : phase === "done" ? (remaining ?? 0) : Math.max(0, total - affected);
  const etaText =
    phase === "running"
      ? etaMs === null
        ? t("progressEtaPending")
        : t("progressEta", { time: formatDuration(etaMs) })
      : undefined;

  return (
    <Modal
      // no-submit: 破壊的な書き込み。Enter / Cmd+Enter で誤って開始させず、キャンセルが既定
      width="640px"
      onClose={guardedClose}
      initialFocusEl={() => cancelBtnRef.current}
    >
      <ModalHeader onClose={guardedClose} closeLabel={t("chunkedDmlClose")}>
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
          {countBuilt.ok && phase === "idle" && isProduction && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void countNow()}
              disabled={manualCount?.status === "loading"}
            >
              {t("chunkedDmlCountNow")}
            </Button>
          )}
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
          <chakra.div display="flex" flexDirection="column" gap="2">
            {/* 毎秒変わる時計系 (バー・経過・ETA・待機秒) は読み上げない。結果は下の role="status" だけ。 */}
            <chakra.div
              aria-live="off"
              display="flex"
              flexDirection="column"
              gap="2"
              data-testid="chunked-dml-clock"
            >
              {ratio !== null && (
                <chakra.div display="flex" alignItems="center" gap="3" data-testid="chunked-dml-progress">
                  <chakra.div flex="1">
                    <DeterminateProgressBar value={ratio} tone={barTone} />
                  </chakra.div>
                  <chakra.span textStyle="numeric" minW="4ch" textAlign="right">
                    {t("progressPercent", { percent: Math.floor(ratio * 100) })}
                  </chakra.span>
                </chakra.div>
              )}
              {total !== null && total > 0 && (
                <chakra.div display="flex" gap="2" flexWrap="wrap" data-testid="chunked-dml-stats">
                  <StatTile label={t("chunkedDmlStatBatches")} value={batches} />
                  <StatTile label={t("chunkedDmlStatRows")} value={affected} />
                  <StatTile
                    label={t("chunkedDmlStatRemaining")}
                    value={remainingEstimate ?? "-"}
                    sub={total !== null ? t("chunkedDmlProgressTotal", { rows: total }) : undefined}
                  />
                  <StatTile
                    label={t("chunkedDmlStatElapsed")}
                    value={formatDuration(elapsedMs)}
                    sub={etaText}
                  />
                </chakra.div>
              )}
              {waitLeft !== null && (
                <chakra.span textStyle="caption" color="app.textMuted" data-testid="chunked-dml-waiting">
                  {t("chunkedDmlWaiting", { secs: waitLeft })}
                </chakra.span>
              )}
            </chakra.div>
            <chakra.div role="status" aria-live="polite" display="flex" flexDirection="column" gap="2">
              {capture && recordedBatches > 0 && (
                <chakra.span textStyle="caption">
                  {t("chunkedDmlRecorded", { count: recordedBatches })}
                </chakra.span>
              )}
              {captureNote && (
                <Callout tone="info">{t("chunkedDmlCaptureDeclined", { reason: captureNote })}</Callout>
              )}
              {phase === "done" &&
                (total === 0 ? (
                  <Callout tone="info">{t("chunkedDmlNothing")}</Callout>
                ) : (
                  <Callout tone="success">{t("chunkedDmlDone", { batches, rows: affected })}</Callout>
                ))}
              {phase === "done" && remaining !== null && remaining > 0 && (
                <Callout tone="warning">{t("chunkedDmlRemaining", { rows: remaining })}</Callout>
              )}
              {phase === "stalled" && (
                <ErrorNote>{t("chunkedDmlStalled", { rows: remaining ?? 0, affected })}</ErrorNote>
              )}
              {phase === "cancelled" && (
                <Callout tone="warning">{t("chunkedDmlCancelled", { batches, rows: affected })}</Callout>
              )}
              {phase === "limit" && (
                <Callout tone="warning">{t("chunkedDmlLimitReached", { limit, rows: affected })}</Callout>
              )}
              {phase === "error" && (
                <ErrorNote>
                  {t("chunkedDmlFailed", { batches, rows: affected, error: error ?? "" })}
                </ErrorNote>
              )}
            </chakra.div>
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
