import { useEffect, useRef, useState } from "react";
import { Flex, chakra } from "@chakra-ui/react";

import { api, type DataDiffHandle } from "../api/tauri";
import { useT } from "../i18n";
import { BroadcastSyncPanel } from "./BroadcastSyncPanel";
import { Callout } from "./Callout";
import { ErrorNote } from "./modalForm";
import { Button } from "./ui";

let fullSeq = 0;
function makeDataDiffStreamId(): string {
  fullSeq += 1;
  return `datadiff_bcast_${Date.now().toString(36)}_${fullSeq.toString(36)}`;
}

/**
 * 結果が 5,000 行を超えた環境の全件比較 (#1625)。
 *
 * ブロードキャスト比較は両側の先頭 5,000 行で打ち切るため、それ以上の表では
 * 「差分なし」が先頭だけの結果になりうる。テーブル閲覧タブ由来 (表名とデータベースが
 * 分かる) のときは、データ比較と同じ主キーのキーセットページング
 * (`compareTableData` の `allRows`) で基準と環境の全行を比べ直す。結果は
 * バックエンドが保持し (`diff_id`)、同期 SQL はそのまま同じ ID から描画する。
 */
export function BroadcastFullCompare({
  baselineSessionId,
  baselineDatabase,
  envSessionId,
  envDatabase,
  envName,
  table,
}: {
  baselineSessionId: string;
  baselineDatabase: string;
  envSessionId: string;
  envDatabase: string;
  envName: string;
  table: string;
}) {
  const t = useT();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [handle, setHandle] = useState<DataDiffHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<string | null>(null);
  const heldRef = useRef<string | null>(null);

  // 閉じたら実行中の問い合わせを止め、保持された差分を解放する。
  useEffect(
    () => () => {
      if (streamRef.current) void api.cancelStream(streamRef.current).catch(() => {});
      if (heldRef.current) void api.releaseDataDiffs([heldRef.current]).catch(() => {});
    },
    [],
  );

  const run = async () => {
    const streamId = makeDataDiffStreamId();
    streamRef.current = streamId;
    setState("running");
    setError(null);
    try {
      const result = await api.compareTableData({
        sourceSessionId: baselineSessionId,
        sourceDatabase: baselineDatabase,
        targetSessionId: envSessionId,
        targetDatabase: envDatabase,
        table,
        allRows: true,
        streamId,
      });
      if (heldRef.current) void api.releaseDataDiffs([heldRef.current]).catch(() => {});
      heldRef.current = result.diff_id;
      setHandle(result);
      setState("done");
    } catch (e) {
      setError(String(e));
      setState("error");
    } finally {
      streamRef.current = null;
    }
  };

  const counts = { source_only: 0, different: 0, target_only: 0 };
  if (handle) for (const r of handle.diff.rows) counts[r.status] += 1;

  return (
    <Flex direction="column" gap="2" px="3" py="2" borderTop="1px solid" borderColor="app.borderSubtle">
      <Flex align="center" gap="3" flexWrap="wrap">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={state === "running"}
          onClick={() => void run()}
        >
          {state === "running" ? t("broadcastFullRunning") : t("broadcastFullRun")}
        </Button>
        {state === "running" && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              if (streamRef.current) void api.cancelStream(streamRef.current).catch(() => {});
            }}
          >
            {t("broadcastFullCancel")}
          </Button>
        )}
        <chakra.span textStyle="caption" color="app.textMuted">
          {t("broadcastFullHint")}
        </chakra.span>
      </Flex>
      {state === "error" && error && <ErrorNote>{error}</ErrorNote>}
      {state === "done" && handle && (
        <>
          <chakra.p margin={0} textStyle="caption" color="app.textMuted" role="status">
            {t("broadcastFullResult", {
              inserts: counts.source_only,
              updates: counts.different,
              deletes: counts.target_only,
            })}
          </chakra.p>
          {handle.diff.truncated && <Callout tone="warning">{t("broadcastFullTruncated")}</Callout>}
          {handle.diff.rows.length > 0 && (
            <BroadcastSyncPanel
              envName={envName}
              loadPlan={(allowDelete) => api.generateDataSyncSql(handle.diff_id, allowDelete)}
            />
          )}
        </>
      )}
    </Flex>
  );
}
