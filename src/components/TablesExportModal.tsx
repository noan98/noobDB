import { useEffect, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { api, listenExportStream, type ExportFormat } from "../api/tauri";
import { useT } from "../i18n";
import { useSettings } from "../settings";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Radio } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";
import { qualifiedTableSql } from "./sqlDialect";
import { batchExportFileName } from "./batchTables";

const FORMATS: ExportFormat[] = ["csv", "json", "ndjson", "markdown", "sql", "xlsx"];

const FORMAT_LABEL_KEYS = {
  csv: "exportFormatCsv",
  json: "exportFormatJson",
  ndjson: "exportFormatNdjson",
  markdown: "exportFormatMarkdown",
  sql: "exportFormatSql",
  xlsx: "exportFormatXlsx",
} as const;

interface Props {
  sessionId: string;
  driver: string;
  database: string;
  tables: string[];
  onClose: () => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "running"; index: number; table: string; rows: number }
  | { kind: "error"; failures: { table: string; error: string }[] };

type OneResult = { ok: true; rows: number } | { ok: false; error: string } | { ok: "cancelled" };

/**
 * スキーマツリーで複数選択したテーブルを、テーブルごとに 1 ファイルでまとめて書き出す (#1399)。
 * 新しい IPC は持たず、既存の `export_query_stream` (SELECT のみ・read_only でも可) を
 * テーブルの数だけ順に呼ぶ。進捗は「n / N テーブル目 + 行数」、キャンセルは実行中のストリームを
 * 止めて残りを打ち切る。失敗したテーブルがあっても残りは続け、最後にまとめて表示する。
 */
export function TablesExportModal({ sessionId, driver, database, tables, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const settings = useSettings();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [dir, setDir] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);
  const disposedRef = useRef(false);
  const userEditedDirRef = useRef(false);
  const isRunning = status.kind === "running";

  // 既定の保存先は OS のダウンロードフォルダ (`ExportModal` と同じ)。取得できなければ空のまま。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await downloadDir();
        if (!cancelled && !userEditedDirRef.current && typeof d === "string") setDir(d);
      } catch {
        // ダウンロードフォルダが解決できない環境ではユーザに選んでもらう。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // アンマウント時は、実行中のストリームを止めて購読を外す。
  useEffect(
    () => () => {
      disposedRef.current = true;
      cancelledRef.current = true;
      const sid = streamIdRef.current;
      if (sid) {
        void api.cancelStream(sid).catch(() => {
          /* すでに終わっている */
        });
      }
      unlistenRef.current?.();
      unlistenRef.current = null;
    },
    [],
  );

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t("batchExportPickDir") });
      if (typeof selected === "string" && selected) {
        userEditedDirRef.current = true;
        setDir(selected);
      }
    } catch (e) {
      toast.error(t("batchExportError", { error: String(e) }));
    }
  };

  /** 1 テーブルを書き出し、完了 / 失敗 / キャンセルのどれかで解決する。 */
  const exportOne = async (table: string, path: string, index: number): Promise<OneResult> => {
    const streamId = `export_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    streamIdRef.current = streamId;
    let settle: (r: OneResult) => void = () => {};
    const done = new Promise<OneResult>((resolve) => {
      settle = resolve;
    });
    const unlisten = await listenExportStream(streamId, {
      onProgress: (e) => setStatus({ kind: "running", index, table, rows: e.rows }),
      onDone: (e) => settle({ ok: true, rows: e.rows }),
      onError: (e) => settle({ ok: false, error: e.message }),
      onCancelled: () => settle({ ok: "cancelled" }),
    });
    unlistenRef.current = unlisten;
    if (disposedRef.current) {
      unlisten();
      return { ok: "cancelled" };
    }
    try {
      await api.exportQueryStream({
        sessionId,
        streamId,
        sql: qualifiedTableSql(driver, database, table),
        database,
        format,
        path,
        initialBatch: Math.max(1, settings.defaultDisplayCount),
        chunkSize: Math.max(1, settings.streamPrefetchSize),
        // 大量出力が途中で打ち切られないよう、エクスポートにはタイムアウトを掛けない。
        queryTimeoutSecs: null,
        table: format === "sql" ? table : null,
        batchSize: null,
        masks: null,
      });
    } catch (e) {
      settle({ ok: false, error: String(e) });
    }
    const result = await done;
    unlisten();
    unlistenRef.current = null;
    streamIdRef.current = null;
    return result;
  };

  const handleExport = async () => {
    if (isRunning || !dir.trim()) return;
    cancelledRef.current = false;
    const used = new Set<string>();
    const failures: { table: string; error: string }[] = [];
    let written = 0;
    for (let i = 0; i < tables.length; i++) {
      if (cancelledRef.current || disposedRef.current) break;
      const table = tables[i] as string;
      setStatus({ kind: "running", index: i, table, rows: 0 });
      let result: OneResult;
      try {
        const path = await join(dir, batchExportFileName(table, format, used));
        result = await exportOne(table, path, i);
      } catch (e) {
        result = { ok: false, error: String(e) };
      }
      if (result.ok === true) written += 1;
      else if (result.ok === false) failures.push({ table, error: result.error });
      else break;
    }
    if (disposedRef.current) return;
    if (cancelledRef.current) {
      setStatus({ kind: "idle" });
      toast.info(t("batchExportCancelled", { done: written, count: tables.length }));
      return;
    }
    if (failures.length > 0) {
      setStatus({ kind: "error", failures });
      toast.error(t("batchExportPartial", { done: written, count: tables.length, failed: failures.length }));
      return;
    }
    toast.success(t("batchExportDone", { count: written, dir }));
    onClose();
  };

  const handleCancelRun = async () => {
    cancelledRef.current = true;
    const sid = streamIdRef.current;
    if (sid) await api.cancelStream(sid).catch(() => undefined);
  };

  return (
    <Modal
      onSubmit={handleExport}
      submitDisabled={isRunning || !dir.trim()}
      width="560px"
      onClose={onClose}
      closeOnInteractOutside={!isRunning}
      closeOnEscape={!isRunning}
    >
      <ModalHeader onClose={onClose} closeLabel={t("exportClose")} closeDisabled={isRunning}>
        {t("batchExportTitle", { count: tables.length })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {t("batchExportNote", { database })}
        </chakra.div>
        <chakra.div fontSize="sm" color="app.text" wordBreak="break-all" data-testid="batch-export-tables">
          {tables.join(", ")}
        </chakra.div>

        <FormSection>
          <FieldLabel as="div">{t("exportFormat")}</FieldLabel>
          <chakra.div role="radiogroup" aria-label={t("exportFormat")} display="flex" flexWrap="wrap" gap="2">
            {FORMATS.map((fmt) => (
              <chakra.label
                key={fmt}
                display="inline-flex"
                alignItems="center"
                gap="1.5"
                py="1.5"
                px="3"
                border="1px solid"
                borderColor={format === fmt ? "app.accent" : "app.border"}
                borderRadius="md"
                fontSize="md"
                cursor="pointer"
                bg={format === fmt ? "app.rowHover" : "app.surface"}
                userSelect="none"
              >
                <Radio
                  name="batch-export-format"
                  value={fmt}
                  checked={format === fmt}
                  onChange={() => setFormat(fmt)}
                  disabled={isRunning}
                  m={0}
                />
                <span>{t(FORMAT_LABEL_KEYS[fmt])}</span>
              </chakra.label>
            ))}
          </chakra.div>
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="batch-export-dir">{t("batchExportDir")}</FieldLabel>
          <PathRow>
            <Input
              id="batch-export-dir"
              flex="1"
              minW={0}
              type="text"
              value={dir}
              onChange={(e) => {
                userEditedDirRef.current = true;
                setDir(e.target.value);
              }}
              placeholder={t("batchExportDirPlaceholder")}
              disabled={isRunning}
            />
            <Button type="button" onClick={handleBrowse} disabled={isRunning}>
              {t("exportBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        {status.kind === "running" && (
          <chakra.div fontSize="sm" color="app.text" role="status" fontWeight={500}>
            {t("batchExportProgress", {
              index: status.index + 1,
              count: tables.length,
              table: status.table,
              rows: status.rows,
            })}
          </chakra.div>
        )}
        {status.kind === "error" && (
          <ErrorNote>
            {status.failures.map((f) => (
              <chakra.div key={f.table} wordBreak="break-all">
                {t("batchExportFailedItem", { table: f.table, error: f.error })}
              </chakra.div>
            ))}
          </ErrorNote>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        {isRunning ? (
          <Button type="button" variant="secondary" onClick={() => void handleCancelRun()}>
            {t("batchExportCancelRun")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("exportCancel")}
          </Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={isRunning}
          onClick={() => void handleExport()}
          disabled={isRunning || !dir.trim()}
        >
          {isRunning ? t("exportSaving") : t("exportExecute")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
