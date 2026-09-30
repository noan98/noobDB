import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  api,
  broadcastEnvStreamId,
  listenBroadcast,
  type BroadcastDiff,
  type CellValue,
  type Column,
  type ConnectionProfile,
  type TableColumnInfo,
} from "../api/tauri";
import { useT } from "../i18n";
import {
  diffToRowDiff,
  MAX_BROADCAST_COMPARE_ROWS,
  resolveKeyIndicesByName,
  type BroadcastRunStatus,
} from "../broadcastCompare";
import { attachRowDiff } from "../resultDiff";
import { semanticColorToken } from "../semanticColors";
import { resolvePkIndices } from "./cellEdit";
import type { ConfirmOptions } from "./ConfirmDialog";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox, Select } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { Spinner } from "./Spinner";
import { ProductionBadge, ProfileColorChip } from "./ProfileBadge";
import { ResultGrid } from "./ResultGrid";

/**
 * 環境横断ブロードキャスト実行 (#738) — 同じ読み取りクエリを複数の接続へ一斉実行し、
 * 現在のフォアグラウンド接続 (基準環境) との差分を各接続ごとに表示する。
 *
 * 2 段階のモーダル:
 * 1. **選択画面** (`step === "select"`): 対象接続 (同一ドライバの開いている接続。
 *    App 側が既に driver でフィルタ済みの `candidates` を渡す) をチェックボックスで
 *    選び、実行する。本番接続が含まれる場合は `confirm` (親から受け取った
 *    `useConfirm()`) で確認を挟む (#675 と同じ tone: "warning" パターン)。
 * 2. **結果画面** (`step === "running"`): `broadcast_compare` (#1257) に全接続を渡す。
 *    バックエンドが N セッションへ並行実行し、環境ごとに「列 + 上限 5,000 行の表示行 +
 *    基準との差分サマリ」だけを Channel で返す (全行を受け取ってフロントで二重に
 *    差分計算していた旧実装の置き換え)。1 接続のエラー/キャンセルは他に影響しない —
 *    環境ごとに独立したタスクで、`broadcastEnvStreamId` で個別にキャンセルできる。
 *
 * PK 特定は実テーブルの `TableColumnInfo` があるとき (この SQL がテーブル閲覧タブ
 * 由来のとき) その主キー列名をバックエンドへ渡す。無い場合は
 * `PinnedComparisonView.tsx` (#622) と同じ発想で、ユーザが基準環境の結果列から
 * キー列を 1 つ選べる (変更するとバックエンドで再比較する)。どちらも解決できなければ
 * バックエンドが行ハッシュ比較へ自動的に降格する。
 *
 * 差分のセル/行ハイライトは `ResultGrid` 既存の diff 描画 (#597) をそのまま使う
 * (`PinnedComparisonView` と同じ「合成 PK 列メタで tableColumns を渡す」手口)。
 * 独自の配色を持たないため #597 と視覚的に完全に一致する。行ハッシュ降格時は
 * `ResultGrid` 側に PK が無いため個別ハイライトはできず、追加/欠落件数のみを
 * テキストで表示する。
 */

interface Candidate {
  sessionId: string;
  profile: ConnectionProfile;
}

interface Entry {
  sessionId: string;
  profile: ConnectionProfile;
  status: BroadcastRunStatus;
  columns: Column[];
  /** 先頭 MAX_BROADCAST_COMPARE_ROWS 行までの表示行。 */
  rows: CellValue[][];
  /** 打ち切り前の総行数。 */
  totalRows: number;
  elapsedMs: number;
  error: string | null;
  /** バックエンドが計算した基準環境との差分 (基準自身・未到着・比較不能のときは null)。 */
  diff: BroadcastDiff | null;
}

export interface BroadcastModalProps {
  sql: string;
  driver: string;
  baselineSessionId: string;
  baselineProfile: ConnectionProfile;
  /** 現在の接続と同一ドライバの、他に開いている接続 (App 側でフィルタ済み)。 */
  candidates: Candidate[];
  /** 発火元タブが "table" タブのときの実テーブル列メタ。PK 自動解決に使う。 */
  tableColumns?: TableColumnInfo[] | null;
  autoLimit: number | null;
  queryTimeoutSecs: number;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  onClose: () => void;
}

let broadcastSeq = 0;
function newBroadcastRunId(): string {
  broadcastSeq += 1;
  return `bcast_${Date.now().toString(36)}_${broadcastSeq.toString(36)}`;
}

function syntheticPkColumns(columns: Column[], pkNames: Set<string>): TableColumnInfo[] {
  return columns.map((c) => ({
    name: c.name,
    data_type: c.type_name,
    nullable: true,
    key: pkNames.has(c.name) ? "PRI" : "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  }));
}

function entryResult(e: Entry) {
  return {
    columns: e.columns,
    rows: e.rows,
    rows_affected: e.totalRows || e.rows.length,
    elapsed_ms: e.elapsedMs,
  };
}

export function BroadcastModal({
  sql,
  driver,
  baselineSessionId,
  baselineProfile,
  candidates,
  tableColumns,
  autoLimit,
  queryTimeoutSecs,
  confirm,
  onClose,
}: BroadcastModalProps) {
  const t = useT();
  const [step, setStep] = useState<"select" | "running">("select");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.map((c) => c.sessionId)),
  );
  const [entries, setEntries] = useState<Entry[]>([]);
  const [keyColumn, setKeyColumn] = useState<string>("");
  const entriesRef = useRef<Entry[]>([]);
  entriesRef.current = entries;
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // 現在の実行 (run) の識別子と、その対象。キー列の変更で同じ対象を再比較するために持つ。
  const runIdRef = useRef<string | null>(null);
  const targetsRef = useRef<Candidate[]>([]);

  // 実行中の環境を個別にキャンセルする (stream id は `{runId}:{sessionId}`)。
  const cancelRunning = () => {
    const runId = runIdRef.current;
    if (!runId) return;
    for (const e of entriesRef.current) {
      if (e.status === "running") void api.cancelStream(broadcastEnvStreamId(runId, e.sessionId));
    }
  };

  // アンマウント時 (モーダルを閉じたとき) は、まだ実行中の環境を個別に
  // キャンセルしてからリスナーを外す。閉じた後もバックエンドのタスク/接続を
  // 握ったままにしないため (他のストリーミングコマンドの後始末と同じ方針)。
  useEffect(() => {
    return () => {
      cancelRunning();
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSelected = (sessionId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const patchEntry = (sessionId: string, patch: Partial<Entry> | ((e: Entry) => Entry)) => {
    setEntries((prev) =>
      prev.map((e) =>
        e.sessionId === sessionId
          ? typeof patch === "function"
            ? patch(e)
            : { ...e, ...patch }
          : e,
      ),
    );
  };

  // `broadcast_compare` を 1 回実行する。`baseline` を先頭に、全環境を並行実行し、
  // 環境ごとの結果 (表示行 + 差分サマリ) が届くたびに対応するカードを更新する。
  const startRun = async (targets: Candidate[], userKeyColumn: string) => {
    unlistenRef.current?.();
    const runId = newBroadcastRunId();
    runIdRef.current = runId;
    targetsRef.current = targets;
    // 古い run のメッセージは無視する (キー列の変更で再実行したときの取りこぼし防止)。
    const live = (fn: () => void) => () => {
      if (runIdRef.current === runId) fn();
    };
    setEntries(
      targets.map((c) => ({
        sessionId: c.sessionId,
        profile: c.profile,
        status: "running" as const,
        columns: [],
        rows: [],
        totalRows: 0,
        elapsedMs: 0,
        error: null,
        diff: null,
      })),
    );
    setStep("running");
    const unlisten = await listenBroadcast(runId, {
      onEnv: (rep) =>
        live(() =>
          patchEntry(rep.sessionId, {
            status: rep.status === "error" ? "error" : "done",
            columns: rep.columns,
            rows: rep.rows,
            totalRows: rep.totalRows,
            elapsedMs: rep.elapsedMs,
            error: rep.error,
            diff: rep.diff,
          }),
        )(),
      onCancelled: ({ sessionId }) =>
        live(() => patchEntry(sessionId, { status: "cancelled" }))(),
    });
    unlistenRef.current = unlisten;

    const [baselineTarget, ...rest] = targets;
    try {
      await api.broadcastCompare({
        runId,
        sql,
        baselineSessionId: baselineTarget.sessionId,
        targetSessionIds: rest.map((c) => c.sessionId),
        autoLimit,
        queryTimeoutSecs,
        tablePkColumns: (tableColumns ?? [])
          .filter((c) => c.key.toUpperCase() === "PRI")
          .map((c) => c.name),
        userKeyColumn: userKeyColumn || null,
      });
    } catch (e) {
      live(() =>
        setEntries((prev) =>
          prev.map((en) =>
            en.status === "running" ? { ...en, status: "error", error: String(e) } : en,
          ),
        ),
      )();
    }
  };

  const handleRun = async () => {
    const chosen = candidates.filter((c) => selected.has(c.sessionId));
    const involved = [baselineProfile, ...chosen.map((c) => c.profile)];
    const productionNames = involved.filter((p) => p.is_production).map((p) => p.name);
    if (productionNames.length > 0) {
      const ok = await confirm({
        title: t("broadcastProductionConfirmTitle"),
        message: t("broadcastProductionConfirmMessage", { names: productionNames.join(", ") }),
        confirmLabel: t("broadcastProductionConfirmAction"),
        tone: "warning",
      });
      if (!ok) return;
    }

    const targets: Candidate[] = [
      { sessionId: baselineSessionId, profile: baselineProfile },
      ...chosen,
    ];
    await startRun(targets, keyColumn);
  };

  const cancelEntry = (sessionId: string) => {
    const runId = runIdRef.current;
    const entry = entriesRef.current.find((e) => e.sessionId === sessionId);
    if (runId && entry && entry.status === "running") {
      void api.cancelStream(broadcastEnvStreamId(runId, sessionId));
    }
  };

  const cancelAll = () => cancelRunning();

  // 結果画面でキー列を選び直したら、同じ対象で再比較する (差分の計算はバックエンドが
  // 行うため)。実行中の環境は先にキャンセルする。
  const handleKeyColumnChange = (value: string) => {
    setKeyColumn(value);
    if (step !== "running" || targetsRef.current.length === 0) return;
    cancelRunning();
    void startRun(targetsRef.current, value);
  };

  const anyRunning = entries.some((e) => e.status === "running");

  const handleClose = () => {
    cancelAll();
    onClose();
  };

  const baseline = entries.find((e) => e.sessionId === baselineSessionId) ?? null;

  // PK 特定: 実テーブル列メタ (テーブル閲覧タブ由来) があればそこから、無ければ
  // ユーザが選んだキー列名から解決する。どちらも解決できなければ空 (降格)。
  const pkIndices = useMemo(() => {
    if (!baseline || baseline.columns.length === 0) return [];
    if (tableColumns) {
      const fromReal = resolvePkIndices(baseline.columns, tableColumns);
      if (fromReal.length > 0) return fromReal;
    }
    if (keyColumn) return resolveKeyIndicesByName(baseline.columns, [keyColumn]);
    return [];
  }, [baseline, tableColumns, keyColumn]);
  const pkNames = useMemo(
    () => new Set(baseline ? pkIndices.map((i) => baseline.columns[i]?.name).filter(Boolean) as string[] : []),
    [baseline, pkIndices],
  );

  if (step === "select") {
    return (
      <Modal onSubmit={handleRun} submitDisabled={selected.size === 0} onClose={handleClose} width="560px">
        <ModalHeader onClose={handleClose} closeLabel={t("broadcastClose")}>
          {t("broadcastPickerTitle")}
        </ModalHeader>
        <ModalBody>
          <chakra.p fontSize="sm" color="app.textMuted" mb="3.5">
            {t("broadcastPickerReadOnlyNotice")}
          </chakra.p>
          <Flex direction="column" gap="2.5">
            <Flex align="center" gap="2" fontSize="sm" fontWeight={600} color="app.text">
              {baselineProfile.color && <ProfileColorChip color={baselineProfile.color} size={12} />}
              <chakra.span>{baselineProfile.name}</chakra.span>
              {baselineProfile.is_production && <ProductionBadge compact />}
              <chakra.span color="app.textMuted" fontWeight={400}>
                ({t("broadcastBaselineLabel")})
              </chakra.span>
            </Flex>
            {candidates.length === 0 ? (
              <chakra.span fontSize="sm" color="app.textMuted">
                {t("broadcastPickerEmpty")}
              </chakra.span>
            ) : (
              candidates.map((c) => (
                <chakra.label
                  key={c.sessionId}
                  display="flex"
                  alignItems="center"
                  gap="2"
                  fontSize="sm"
                  cursor="pointer"
                  color="app.text"
                >
                  <Checkbox
                    checked={selected.has(c.sessionId)}
                    onChange={() => toggleSelected(c.sessionId)}
                  />
                  {c.profile.color && <ProfileColorChip color={c.profile.color} size={12} />}
                  <chakra.span>{c.profile.name}</chakra.span>
                  {c.profile.is_production && <ProductionBadge compact />}
                </chakra.label>
              ))
            )}
          </Flex>
        </ModalBody>
        <ModalFooter>
          <chakra.span flex="1" />
          <Button type="button" variant="secondary" onClick={handleClose}>
            {t("broadcastPickerCancel")}
          </Button>
          <LoadingButton
            type="button"
            variant="primary"
            onClick={handleRun}
            disabled={selected.size === 0}
          >
            {t("broadcastPickerRun")}
          </LoadingButton>
        </ModalFooter>
      </Modal>
    );
  }

  return (
    <Modal
      // no-submit: 結果の閲覧画面で、確定する主アクションが無い (閉じるのみ)
      onClose={handleClose} width="min(1120px, 95vw)">
      <ModalHeader onClose={handleClose} closeLabel={t("broadcastClose")}>
        {t("broadcastResultsTitle")}
      </ModalHeader>
      <ModalBody>
        <Flex align="center" gap="3" flexWrap="wrap" mb="3.5">
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("broadcastPickerReadOnlyNotice")}
          </chakra.span>
          {baseline && baseline.columns.length > 0 && (
            <chakra.label display="inline-flex" alignItems="center" gap="2" fontSize="sm" color="app.textMuted">
              {t("broadcastKeyColumnLabel")}
              <Select
                value={keyColumn}
                onChange={(e) => handleKeyColumnChange(e.target.value)}
                minWidth="180px"
                disabled={
                  !!tableColumns && resolvePkIndices(baseline.columns, tableColumns).length > 0
                }
              >
                <option value="">{t("broadcastKeyColumnNone")}</option>
                {baseline.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </chakra.label>
          )}
        </Flex>
        <Flex direction="column" gap="4">
          {entries.map((e) => (
            <EntryCard
              key={e.sessionId}
              entry={e}
              isBaseline={e.sessionId === baselineSessionId}
              baseline={baseline}
              pkNames={pkNames}
              driver={driver}
              onCancel={() => cancelEntry(e.sessionId)}
            />
          ))}
        </Flex>
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" onClick={cancelAll} disabled={!anyRunning}>
          {t("broadcastCancelAll")}
        </Button>
        <chakra.span flex="1" />
        <Button type="button" variant="primary" onClick={handleClose}>
          {t("broadcastClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function statusLabel(t: ReturnType<typeof useT>, status: BroadcastRunStatus): string {
  switch (status) {
    case "running":
      return t("broadcastStatusRunning");
    case "done":
      return t("broadcastStatusDone");
    case "error":
      return t("broadcastStatusError");
    case "cancelled":
      return t("broadcastStatusCancelled");
  }
}

function statusColor(status: BroadcastRunStatus): string {
  switch (status) {
    case "running":
      return "app.textMuted";
    case "done":
      return semanticColorToken("success", "text");
    case "error":
      return semanticColorToken("danger", "text");
    case "cancelled":
      return semanticColorToken("warning", "text");
  }
}

function EntryCard({
  entry,
  isBaseline,
  baseline,
  pkNames,
  driver,
  onCancel,
}: {
  entry: Entry;
  isBaseline: boolean;
  baseline: Entry | null;
  pkNames: Set<string>;
  driver: string;
  onCancel: () => void;
}) {
  const t = useT();
  const settled = entry.status !== "running";
  const baselineSettled = !baseline || baseline.status !== "running";

  // 差分はバックエンドが計算済み (#1257)。ここでは表示用に整形するだけ。
  const diff: BroadcastDiff | null = isBaseline || !settled || !baselineSettled ? null : entry.diff;

  const diffLine = (() => {
    if (isBaseline) return null;
    if (!settled || !baselineSettled) return t("broadcastDiffPending");
    if (!diff) return null;
    if (!diff.comparable) return t("broadcastDiffIncomparable");
    if (!diff.hasDiff) return t("broadcastDiffNone");
    if (diff.mode === "pk") {
      return t("broadcastDiffPk", {
        changed: diff.changedCellCount,
        added: diff.addedRowIndices.length,
        removed: diff.removedCount,
      });
    }
    return t("broadcastDiffHash", {
      added: diff.addedRowIndices.length,
      removed: diff.removedCount,
    });
  })();

  // グリッドのセル/行ハイライト用に、バックエンドの差分を `ResultRowDiff` へ変換して
  // 行配列に紐づける。`ResultGrid` は紐づいた差分があれば全行の突き合わせ
  // (`diffResultRows`) をやり直さない。
  const rowDiff = useMemo(
    () =>
      diff && diff.mode === "pk"
        ? diffToRowDiff(diff, entry.rows.length, entry.columns.length)
        : null,
    [diff, entry.rows.length, entry.columns.length],
  );
  // 行配列への紐づけは WeakMap への冪等な登録なので、描画中に行っても安全
  // (グリッドの初回描画より前に揃っている必要がある)。
  if (rowDiff) attachRowDiff(entry.rows, rowDiff);

  const tableColumnsForGrid =
    diff && diff.mode === "pk" ? syntheticPkColumns(entry.columns, pkNames) : undefined;

  return (
    <Box borderWidth="1px" borderColor="app.border" borderRadius="md" overflow="hidden">
      <Flex
        align="center"
        gap="2.5"
        px="3"
        py="2"
        bg="app.toolbar"
        borderBottom="1px solid"
        borderColor="app.border"
        flexWrap="wrap"
      >
        {entry.profile.color && <ProfileColorChip color={entry.profile.color} size={12} />}
        <chakra.span fontWeight={600} fontSize="sm" color="app.text">
          {entry.profile.name}
        </chakra.span>
        {entry.profile.is_production && <ProductionBadge compact />}
        {isBaseline && (
          <chakra.span fontSize="xs" color="app.textMuted">
            ({t("broadcastBaselineLabel")})
          </chakra.span>
        )}
        <Flex align="center" gap="1.5" fontSize="xs" fontWeight={600} color={statusColor(entry.status)}>
          {entry.status === "running" && <Spinner size={12} />}
          {statusLabel(t, entry.status)}
        </Flex>
        <chakra.span fontSize="xs" color="app.textMuted">
          {entry.totalRows > entry.rows.length
            ? t("broadcastRowsShown", { rows: entry.totalRows, shown: entry.rows.length })
            : t("broadcastRowCount", { rows: entry.totalRows || entry.rows.length })}
        </chakra.span>
        <chakra.span flex="1" />
        {entry.status === "running" && (
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            {t("broadcastCancelEntry")}
          </Button>
        )}
      </Flex>
      {diffLine && (
        <Box
          px="3"
          py="1.5"
          fontSize="xs"
          color={diff && !diff.comparable ? semanticColorToken("warning", "text") : "app.textMuted"}
          borderBottom="1px solid"
          borderColor="app.borderSubtle"
        >
          {diffLine}
          {diff?.truncated && (
            <chakra.span ml="2" color={semanticColorToken("warning", "text")}>
              {t("broadcastDiffTruncated", { max: MAX_BROADCAST_COMPARE_ROWS })}
            </chakra.span>
          )}
        </Box>
      )}
      {entry.status === "error" && entry.error && (
        <Box px="3" py="1.5" fontSize="xs" color={semanticColorToken("danger", "text")}>
          {t("broadcastErrorLabel", { error: entry.error })}
        </Box>
      )}
      <Box height="320px" display="flex" flexDirection="column" minHeight={0}>
        <ResultGrid
          result={entryResult(entry)}
          streaming={entry.status === "running"}
          driver={driver}
          tableColumns={tableColumnsForGrid}
          diffPrevRows={tableColumnsForGrid ? baseline?.rows ?? null : null}
          diffComparable={!!tableColumnsForGrid}
          diffHighlightEnabled={!!tableColumnsForGrid}
        />
      </Box>
    </Box>
  );
}
