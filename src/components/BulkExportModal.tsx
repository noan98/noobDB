import { useEffect, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, listenExportStream, type ExportFormat } from "../api/tauri";
import { useT } from "../i18n";
import { useSettings } from "../settings";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Radio } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";
import { DEFAULT_SQL_BATCH } from "./exportPreview";
import { qualifiedTableSql } from "./sqlDialect";
import { BULK_EXPORT_FORMATS, bulkExportPaths } from "./tableBulk";

interface Props {
  sessionId: string;
  driver: string;
  database: string;
  tables: string[];
  onClose: () => void;
}

const FORMAT_LABELS = {
  csv: "exportFormatCsv",
  json: "exportFormatJson",
  ndjson: "exportFormatNdjson",
  markdown: "exportFormatMarkdown",
  sql: "exportFormatSql",
  xlsx: "exportFormatXlsx",
} as const;

/** 選択した複数テーブルを、フォルダ内のテーブルごとのファイルへ順に書き出す (#1399)。
 *  1 テーブルぶんは既存の `export_query_stream` (SELECT *) をそのまま使う。 */
export function BulkExportModal({ sessionId, driver, database, tables, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const settings = useSettings();
  const [dir, setDir] = useState("");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [running, setRunning] = useState<{ current: number; table: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const streamRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const handleBrowse = async () => {
    const picked = await open({ directory: true, title: t("bulkExportPickTitle") });
    if (typeof picked === "string" && picked) setDir(picked);
  };

  /** 1 テーブルを書き出し、完了で resolve・失敗で reject する。 */
  const exportOne = async (table: string, path: string): Promise<void> => {
    const streamId = `export_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    streamRef.current = streamId;
    let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
    const done = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const unlisten = await listenExportStream(streamId, {
      onDone: () => settle?.resolve(),
      onError: (e) => settle?.reject(new Error(e.message)),
      onCancelled: () => settle?.resolve(),
    });
    try {
      await api.exportQueryStream({
        sessionId,
        streamId,
        sql: qualifiedTableSql(driver, database, table),
        database,
        format,
        path,
        initialBatch: settings.defaultDisplayCount,
        chunkSize: settings.streamPrefetchSize,
        queryTimeoutSecs: null,
        table,
        batchSize: DEFAULT_SQL_BATCH,
      });
      await done;
    } finally {
      unlisten();
      streamRef.current = null;
    }
  };

  const handleExport = async () => {
    if (!dir.trim() || running) return;
    cancelledRef.current = false;
    setError(null);
    let finished = 0;
    // 名前が重なるテーブルがあっても別ファイルになるよう、出力先は先に全件ぶん決める。
    const paths = bulkExportPaths(dir, tables, format);
    for (const [i, table] of tables.entries()) {
      if (cancelledRef.current || disposedRef.current) break;
      setRunning({ current: i + 1, table });
      try {
        const path = paths[i];
        if (path === undefined) throw new Error("export path was not resolved");
        await exportOne(table, path);
        finished += 1;
      } catch (e) {
        const message = t("bulkExportFailed", { table, error: String(e) });
        if (!disposedRef.current) setError(message);
        toast.error(message);
        setRunning(null);
        return;
      }
    }
    if (!cancelledRef.current && finished === tables.length) {
      toast.success(t("bulkExportDone", { count: finished, dir }));
      onClose();
      return;
    }
    if (!disposedRef.current) setRunning(null);
  };

  const handleCancelRun = async () => {
    cancelledRef.current = true;
    const id = streamRef.current;
    if (id) await api.cancelStream(id).catch(() => undefined);
  };

  const isRunning = running !== null;
  return (
    <Modal
      onSubmit={handleExport}
      submitDisabled={isRunning || !dir.trim()}
      width="560px"
      onClose={onClose}
      closeOnInteractOutside={!isRunning}
      closeOnEscape={!isRunning}
    >
      <ModalHeader onClose={onClose} closeLabel={t("bulkExportClose")} closeDisabled={isRunning}>
        {t("bulkExportTitle", { count: tables.length })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight="normal">
          {t("bulkExportNote")}
        </chakra.div>
        <FormSection>
          <FieldLabel as="div">{t("exportFormat")}</FieldLabel>
          <chakra.div role="radiogroup" aria-label={t("exportFormat")} display="flex" flexWrap="wrap" gap="3">
            {BULK_EXPORT_FORMATS.map((fmt) => (
              <chakra.label key={fmt} display="inline-flex" alignItems="center" gap="1.5" fontSize="md" cursor="pointer">
                <Radio
                  name="bulk-export-format"
                  value={fmt}
                  checked={format === fmt}
                  onChange={() => setFormat(fmt)}
                  disabled={isRunning}
                  m={0}
                />
                {t(FORMAT_LABELS[fmt])}
              </chakra.label>
            ))}
          </chakra.div>
        </FormSection>
        <FormSection>
          <FieldLabel htmlFor="bulk-export-dir">{t("bulkExportFolder")}</FieldLabel>
          <PathRow>
            <Input
              id="bulk-export-dir"
              flex="1"
              minW={0}
              type="text"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              disabled={isRunning}
            />
            <Button type="button" onClick={handleBrowse} disabled={isRunning}>
              {t("bulkExportBrowse")}
            </Button>
          </PathRow>
        </FormSection>
        {running && (
          <chakra.div fontSize="sm" color="app.textMuted" textStyle="numeric" role="status">
            {t("bulkExportRunning", { current: running.current, total: tables.length, table: running.table })}
          </chakra.div>
        )}
        {error && <ErrorNote role="alert">{error}</ErrorNote>}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        {isRunning ? (
          <Button type="button" variant="secondary" onClick={() => void handleCancelRun()}>
            {t("bulkExportCancelRun")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("bulkExportCancel")}
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
          {t("bulkExportRun")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
