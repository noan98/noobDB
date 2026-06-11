import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, CellValue, Column, ExportFormat, listenExportStream } from "../api/tauri";
import { useT } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Radio } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";

/**
 * 全件ストリーミングエクスポート (#494) に必要な情報。提供されると「全件 (再実行)」
 * モードが選べるようになる。`sql` は再実行する SELECT 系クエリ。
 */
export interface FullExportContext {
  sessionId: string;
  sql: string;
  initialBatch: number;
  chunkSize: number;
}

interface Props {
  columns: Column[];
  rows: CellValue[][];
  database: string | null;
  table: string | null;
  /**
   * True when the grid holds only part of the result set (an auto LIMIT is
   * binding, or more pages can still be loaded). Surfaces a warning so the
   * user doesn't mistake a partial export for the full set.
   */
  partial?: boolean;
  /** 全件エクスポートのコンテキスト (#494)。未提供ならグリッドのみエクスポート。 */
  fullExport?: FullExportContext;
  onClose: () => void;
}

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, "0");
}

function timestamp(now = new Date()): string {
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "_" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function sanitizeForFilename(s: string): string {
  // Replace characters that are unsafe across Windows/macOS/Linux filenames
  // with an underscore. Trim trailing dots/spaces (Windows quirk).
  return s
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/[ .]+$/, "")
    .trim();
}

function defaultBasename(database: string | null, table: string | null): string {
  const ts = timestamp();
  const schema = sanitizeForFilename(database ?? "");
  const tbl = sanitizeForFilename(table ?? "");
  if (schema && tbl) return `${schema}_${tbl}_${ts}`;
  if (schema) return `${schema}_query_${ts}`;
  if (tbl) return `${tbl}_${ts}`;
  return `query_${ts}`;
}

function extensionFor(format: ExportFormat): string {
  return format === "csv" ? ".csv" : ".json";
}

function replaceExtension(path: string, newExt: string): string {
  // Operate on the last segment so e.g. `C:\folder.with.dot\file.csv` works.
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return dir + stem + newExt;
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "streaming"; rows: number; streamId: string }
  | { kind: "error"; message: string };

/** エクスポート対象: 現在のグリッドのみ / クエリを再実行して全件 (#494)。 */
type ExportScope = "current" | "full";

export function ExportModal({ columns, rows, database, table, partial, fullExport, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>("csv");
  // 部分結果かつ全件モードが使えるときは「全件」を初期選択にし、誤って部分だけ
  // 書き出すのを防ぐ。それ以外は従来どおりグリッドのみ。
  const [scope, setScope] = useState<ExportScope>(fullExport && partial ? "full" : "current");
  const initialBasename = useMemo(() => defaultBasename(database, table), [database, table]);
  const [path, setPath] = useState<string>(`${initialBasename}${extensionFor("csv")}`);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const unlistenRef = useRef<(() => void) | null>(null);
  // Set on unmount so an in-flight `listenExportStream` (awaited below) can
  // tell its registration arrived too late and must self-unlisten — otherwise
  // the listener would be orphaned (the cleanup below has already run).
  const disposedRef = useRef(false);

  useEffect(
    () => () => {
      disposedRef.current = true;
      unlistenRef.current?.();
    },
    [],
  );

  const isSaving = status.kind === "saving" || status.kind === "streaming";

  // When the format changes, swap the extension on the current path. This
  // keeps the user's chosen directory but reflects the new format. If the
  // path is empty, just set the default.
  useEffect(() => {
    setPath((cur) => {
      if (!cur) return `${initialBasename}${extensionFor(format)}`;
      return replaceExtension(cur, extensionFor(format));
    });
    // intentionally exclude `initialBasename` so changing the timestamp
    // doesn't overwrite an in-progress path edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format]);

  const handleBrowse = async () => {
    const selected = await save({
      defaultPath: path || `${initialBasename}${extensionFor(format)}`,
      title: t("exportPickFileTitle"),
      filters: [
        format === "csv"
          ? { name: "CSV", extensions: ["csv"] }
          : { name: "JSON", extensions: ["json"] },
      ],
    });
    if (typeof selected === "string" && selected) {
      setPath(selected);
    }
  };

  const handleExport = async () => {
    if (!path.trim()) return;
    if (scope === "full" && fullExport) {
      await handleFullExport(fullExport);
      return;
    }
    if (rows.length === 0) {
      setStatus({ kind: "error", message: t("exportNoData") });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const bytes = await api.exportQueryResult({ path, format, columns, rows });
      toast.success(t("exportSuccess", { bytes, path }));
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      toast.error(t("exportError", { error: String(e) }));
    }
  };

  // 全件モード: クエリを再実行してバックエンドでストリーミング書き出し (#494)。
  const handleFullExport = async (ctx: FullExportContext) => {
    const streamId = `export_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    setStatus({ kind: "streaming", rows: 0, streamId });
    unlistenRef.current?.();
    const unlisten = await listenExportStream(streamId, {
      onProgress: (e) =>
        setStatus((cur) => (cur.kind === "streaming" ? { ...cur, rows: e.rows } : cur)),
      onDone: (e) => {
        unlistenRef.current?.();
        unlistenRef.current = null;
        toast.success(t("exportFullDone", { rows: e.rows, bytes: e.bytes, path }));
        setStatus({ kind: "idle" });
      },
      onError: (e) => {
        unlistenRef.current?.();
        unlistenRef.current = null;
        setStatus({ kind: "error", message: e.message });
        toast.error(t("exportError", { error: e.message }));
      },
    });
    // The modal may have unmounted while the listener was attaching; its
    // cleanup already ran, so register nothing and drop the listener here.
    if (disposedRef.current) {
      unlisten();
      return;
    }
    unlistenRef.current = unlisten;
    try {
      await api.exportQueryStream({
        sessionId: ctx.sessionId,
        streamId,
        sql: ctx.sql,
        database,
        format,
        path,
        initialBatch: ctx.initialBatch,
        chunkSize: ctx.chunkSize,
        // 大量出力が途中で打ち切られないよう、エクスポートにはタイムアウトを掛けない。
        queryTimeoutSecs: null,
      });
    } catch (e) {
      unlisten();
      unlistenRef.current = null;
      setStatus({ kind: "error", message: String(e) });
      toast.error(t("exportError", { error: String(e) }));
    }
  };

  const handleCancelStream = async () => {
    if (status.kind !== "streaming") return;
    await api.cancelStream(status.streamId);
    unlistenRef.current?.();
    unlistenRef.current = null;
    setStatus({ kind: "idle" });
  };

  return (
    <Modal
      width="560px"
      onClose={onClose}
      closeOnInteractOutside={!isSaving}
      closeOnEscape={!isSaving}
    >
      <ModalHeader onClose={onClose} closeLabel={t("exportClose")} closeDisabled={isSaving}>
        {t("exportTitle")}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="var(--space-4)">
        <chakra.div fontSize="md" color="app.text">
          {t("exportRowCount", { rows: rows.length })}
        </chakra.div>
        {fullExport && (
          <FormSection>
            <FieldLabel as="div">{t("exportScope")}</FieldLabel>
            <chakra.div role="radiogroup" aria-label={t("exportScope")} display="flex" flexDirection="column" gap="1.5">
              {(["current", "full"] as const).map((sc) => (
                <chakra.label key={sc} display="inline-flex" alignItems="flex-start" gap="2" cursor="pointer" userSelect="none">
                  <Radio
                    name="export-scope"
                    value={sc}
                    checked={scope === sc}
                    onChange={() => setScope(sc)}
                    disabled={isSaving}
                    mt="3px"
                  />
                  <chakra.span display="flex" flexDirection="column">
                    <chakra.span fontSize="md">{sc === "current" ? t("exportScopeCurrent") : t("exportScopeFull")}</chakra.span>
                    <chakra.span fontSize="xs" color="app.textMuted">
                      {sc === "current" ? t("exportScopeCurrentHint", { rows: rows.length }) : t("exportScopeFullHint")}
                    </chakra.span>
                  </chakra.span>
                </chakra.label>
              ))}
            </chakra.div>
          </FormSection>
        )}
        {status.kind === "streaming" && (
          <chakra.div fontSize="sm" color="app.textSecondary">
            {t("exportFullProgress", { rows: status.rows })}
          </chakra.div>
        )}
        {partial && scope === "current" && (
          <chakra.div
            role="status"
            py="2" px="2.5"
            border="1px solid"
            borderColor="color-mix(in srgb, #f59e0b 50%, var(--border))"
            bg="color-mix(in srgb, #f59e0b 14%, var(--bg-muted))"
            color="app.text"
            borderRadius="md"
            fontSize="sm"
            lineHeight={1.5}
          >
            {t("exportPartialWarning")}
          </chakra.div>
        )}
        <FormSection>
          <FieldLabel as="div">{t("exportFormat")}</FieldLabel>
          <chakra.div
            role="radiogroup"
            aria-label={t("exportFormat")}
            display="flex"
            gap="var(--space-2)"
          >
            {(["csv", "json"] as const).map((fmt) => (
              <chakra.label
                key={fmt}
                display="inline-flex"
                alignItems="center"
                gap="1.5"
                py="1.5" px="3"
                border="1px solid"
                borderColor={format === fmt ? "app.accent" : "app.border"}
                borderRadius="md"
                fontSize="md"
                cursor="pointer"
                bg={format === fmt ? "app.rowHover" : "app.surface"}
                userSelect="none"
              >
                <Radio
                  name="export-format"
                  value={fmt}
                  checked={format === fmt}
                  onChange={() => setFormat(fmt)}
                  disabled={isSaving}
                  m={0}
                />
                <span>{fmt === "csv" ? t("exportFormatCsv") : t("exportFormatJson")}</span>
              </chakra.label>
            ))}
          </chakra.div>
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="export-path">{t("exportSavePath")}</FieldLabel>
          <PathRow>
            <Input
              id="export-path"
              flex="1"
              minW={0}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("exportSavePathPlaceholder")}
              disabled={isSaving}
            />
            <Button type="button" onClick={handleBrowse} disabled={isSaving}>
              {t("exportBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        {status.kind === "error" && (
          <ErrorNote>{t("exportError", { error: status.message })}</ErrorNote>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        {status.kind === "streaming" ? (
          <Button type="button" variant="secondary" onClick={handleCancelStream}>
            {t("exportStreamCancel")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose} disabled={isSaving}>
            {t("exportCancel")}
          </Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={status.kind === "saving"}
          onClick={handleExport}
          disabled={isSaving || !path.trim()}
        >
          {status.kind === "streaming"
            ? t("exportStreamRunning")
            : isSaving
              ? t("exportSaving")
              : t("exportExecute")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
