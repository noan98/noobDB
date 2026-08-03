import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Flex, chakra } from "@chakra-ui/react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  api,
  listenQueryStream,
  type CellValue,
  type Column,
  type ConnectionProfile,
  type TableColumnInfo,
} from "../api/tauri";
import { useT } from "../i18n";
import {
  compareBroadcastEnvironment,
  countChangedCells,
  MAX_BROADCAST_COMPARE_ROWS,
  resolveKeyIndicesByName,
  type BroadcastRunStatus,
} from "../broadcastCompare";
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
 * 2. **結果画面** (`step === "running"`): 各接続を独立した `streamId` で
 *    `run_query_stream` (`forceReadOnly: true`) に投げ、`listenQueryStream` で
 *    購読する。1 接続のエラー/キャンセルは他に一切影響しない — ストリーム登録・
 *    イベント購読ともに接続ごとに完全に分離しているため。
 *
 * PK 特定は `components/cellEdit.ts::resolvePkIndices` (実テーブルの
 * `TableColumnInfo` があるとき、つまりこの SQL がテーブル閲覧タブ由来のとき) を
 * そのまま再利用する。無い場合は `PinnedComparisonView.tsx` (#622) と同じ発想で、
 * ユーザが基準環境の結果列からキー列を 1 つ選べる。どちらも解決できなければ
 * `pkIndices` は空のままとなり、`compareBroadcastEnvironment` が行ハッシュ比較へ
 * 自動的に降格する。
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
  streamId: string;
  status: BroadcastRunStatus;
  columns: Column[];
  rows: CellValue[][];
  rowsAffected: number;
  elapsedMs: number;
  error: string | null;
  deliveredRows: number;
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
  initialBatch: number;
  chunkSize: number;
  autoLimit: number | null;
  queryTimeoutSecs: number;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  onClose: () => void;
}

let broadcastSeq = 0;
function newBroadcastStreamId(sessionId: string): string {
  broadcastSeq += 1;
  return `bcast_${sessionId}_${Date.now().toString(36)}_${broadcastSeq.toString(36)}`;
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
    rows_affected: e.rowsAffected || e.rows.length,
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
  initialBatch,
  chunkSize,
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
  const unlistenRef = useRef<Map<string, UnlistenFn>>(new Map());

  // アンマウント時 (モーダルを閉じたとき) は、まだ実行中のストリームを個別に
  // キャンセルしてからリスナーを外す。閉じた後もバックエンドのタスク/接続を
  // 握ったままにしないため (他のストリーミングコマンドの後始末と同じ方針)。
  useEffect(() => {
    return () => {
      for (const e of entriesRef.current) {
        if (e.status === "running") void api.cancelStream(e.streamId);
      }
      for (const un of unlistenRef.current.values()) un();
      unlistenRef.current.clear();
    };
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

  const runOneEntry = async (entry: Entry) => {
    const unlisten = await listenQueryStream(entry.streamId, {
      onColumns: ({ columns }) => patchEntry(entry.sessionId, { columns }),
      onRows: ({ rows }) =>
        patchEntry(entry.sessionId, (e) => ({ ...e, rows: [...e.rows, ...rows] })),
      onDone: ({ totalRows, rowsAffected, elapsedMs, hasColumns }) => {
        patchEntry(entry.sessionId, {
          status: "done",
          rowsAffected: hasColumns ? totalRows : rowsAffected,
          elapsedMs,
        });
      },
      // 接続断もこのモーダルには再接続導線が無いため、素のエラーとしてそのまま表示する
      // (App 本体の実行経路と違い connectionLost を特別扱いしない)。
      onError: ({ error }) => {
        patchEntry(entry.sessionId, {
          status: "error",
          error: error ?? "unknown error",
        });
      },
      onCancelled: ({ deliveredRows }) => {
        patchEntry(entry.sessionId, { status: "cancelled", deliveredRows });
      },
    });
    unlistenRef.current.set(entry.sessionId, unlisten);

    try {
      await api.runQueryStream({
        sessionId: entry.sessionId,
        streamId: entry.streamId,
        sql,
        initialBatch,
        chunkSize,
        autoLimit,
        queryTimeoutSecs,
        forceReadOnly: true,
      });
    } catch (e) {
      patchEntry(entry.sessionId, { status: "error", error: String(e) });
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
    const initialEntries: Entry[] = targets.map((c) => ({
      sessionId: c.sessionId,
      profile: c.profile,
      streamId: newBroadcastStreamId(c.sessionId),
      status: "running",
      columns: [],
      rows: [],
      rowsAffected: 0,
      elapsedMs: 0,
      error: null,
      deliveredRows: 0,
    }));
    setEntries(initialEntries);
    setStep("running");
    for (const entry of initialEntries) {
      void runOneEntry(entry);
    }
  };

  const cancelEntry = (sessionId: string) => {
    const entry = entriesRef.current.find((e) => e.sessionId === sessionId);
    if (entry && entry.status === "running") void api.cancelStream(entry.streamId);
  };

  const cancelAll = () => {
    for (const e of entriesRef.current) {
      if (e.status === "running") void api.cancelStream(e.streamId);
    }
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
      <Modal onClose={handleClose} width="560px">
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
          <Button type="button" variant="secondary" onClick={handleClose}>
            {t("broadcastPickerCancel")}
          </Button>
          <chakra.span flex="1" />
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
    <Modal onClose={handleClose} width="min(1120px, 95vw)">
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
                onChange={(e) => setKeyColumn(e.target.value)}
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
              pkIndices={e.sessionId === baselineSessionId ? [] : pkIndices}
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
      return "var(--status-success)";
    case "error":
      return "var(--status-error)";
    case "cancelled":
      return "var(--status-warning)";
  }
}

function EntryCard({
  entry,
  isBaseline,
  baseline,
  pkIndices,
  pkNames,
  driver,
  onCancel,
}: {
  entry: Entry;
  isBaseline: boolean;
  baseline: Entry | null;
  pkIndices: number[];
  pkNames: Set<string>;
  driver: string;
  onCancel: () => void;
}) {
  const t = useT();
  const settled = entry.status !== "running";
  const baselineSettled = !baseline || baseline.status !== "running";

  const diff = useMemo(() => {
    if (isBaseline || !baseline || !settled || !baselineSettled) return null;
    if (baseline.columns.length === 0 || entry.columns.length === 0) return null;
    return compareBroadcastEnvironment(
      { columns: baseline.columns, rows: baseline.rows },
      { columns: entry.columns, rows: entry.rows },
      pkIndices,
    );
  }, [isBaseline, baseline, entry, pkIndices, settled, baselineSettled]);

  const diffLine = (() => {
    if (isBaseline) return null;
    if (!settled || !baselineSettled) return t("broadcastDiffPending");
    if (!diff) return null;
    if (!diff.comparable) return t("broadcastDiffIncomparable");
    if (!diff.hasDiff) return t("broadcastDiffNone");
    if (diff.mode === "pk") {
      return t("broadcastDiffPk", {
        changed: countChangedCells(diff.changedCells),
        added: diff.addedRowIndices.size,
        removed: diff.removedCount,
      });
    }
    return t("broadcastDiffHash", {
      added: diff.addedRowIndices.size,
      removed: diff.removedCount,
    });
  })();

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
          {t("broadcastRowCount", { rows: entry.rows.length })}
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
          color={diff && !diff.comparable ? "var(--status-warning)" : "app.textMuted"}
          borderBottom="1px solid"
          borderColor="app.borderSubtle"
        >
          {diffLine}
          {diff?.truncated && (
            <chakra.span ml="2" color="var(--status-warning)">
              {t("broadcastDiffTruncated", { max: MAX_BROADCAST_COMPARE_ROWS })}
            </chakra.span>
          )}
        </Box>
      )}
      {entry.status === "error" && entry.error && (
        <Box px="3" py="1.5" fontSize="xs" color="var(--status-error)">
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
