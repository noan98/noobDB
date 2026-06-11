import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  listenImportStream,
  type ColumnMapping,
  type CsvPreview,
  type ImportOptions,
  type TableColumnInfo,
} from "../api/tauri";
import { chakra } from "@chakra-ui/react";
import { motion } from "motion/react";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { transitions } from "../motion";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, PressableButton, Select, Switch } from "./ui";
import { Spinner } from "./Spinner";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";

interface Props {
  sessionId: string;
  database: string;
  table: string;
  onClose: () => void;
  /** Called after a successful import so the caller can refresh the grid. */
  onImported: () => void;
  /**
   * Pre-selected file path (#497). When the modal is opened by dropping a
   * `.csv` onto the window, the path is filled in up front so the preview
   * loads immediately without the user re-picking the file.
   */
  initialPath?: string;
}

type DelimiterChoice = "," | "\t" | ";";
type NullMode = "none" | "empty" | "custom";

type Status =
  | { kind: "idle" }
  | { kind: "importing"; inserted: number; total: number }
  | { kind: "error"; message: string };

const ENCODINGS = ["utf-8", "shift_jis", "euc-jp", "utf-16le", "windows-1252"];

function newStreamId(): string {
  return `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

// The backend CSV parser operates on single bytes, so the quote character must
// be exactly one ASCII character. Reject empty, multi-character, and multi-byte
// (e.g. `「` or emoji) input before it reaches the server.
function isValidSingleByteChar(s: string): boolean {
  return s.length === 1 && s.charCodeAt(0) < 128;
}

/**
 * Auto-pairs destination columns with CSV fields: by header name when a header
 * row is present and at least one name matches, otherwise positionally. Columns
 * with no candidate map to `null` (skipped).
 */
function autoMap(
  tableCols: TableColumnInfo[],
  headers: string[],
  hasHeader: boolean,
): Record<string, number | null> {
  const byName = tableCols.map((c) =>
    headers.findIndex((h) => norm(h) === norm(c.name)),
  );
  const anyName = byName.some((i) => i >= 0);
  const m: Record<string, number | null> = {};
  tableCols.forEach((c, i) => {
    if (hasHeader && anyName) {
      m[c.name] = byName[i] >= 0 ? byName[i] : null;
    } else {
      m[c.name] = i < headers.length ? i : null;
    }
  });
  return m;
}

export function ImportModal({ sessionId, database, table, onClose, onImported, initialPath }: Props) {
  const t = useT();
  const toast = useToast();
  const [path, setPath] = useState(initialPath ?? "");
  const [encoding, setEncoding] = useState("utf-8");
  const [delimiter, setDelimiter] = useState<DelimiterChoice>(",");
  const [quote, setQuote] = useState('"');
  const [hasHeader, setHasHeader] = useState(true);
  const [nullMode, setNullMode] = useState<NullMode>("empty");
  const [nullCustom, setNullCustom] = useState("NULL");

  const [tableColumns, setTableColumns] = useState<TableColumnInfo[] | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const streamIdRef = useRef<string | null>(null);
  // Set on unmount so an in-flight `listenImportStream` (awaited in
  // handleImport) can tell its registration arrived too late and must
  // self-unlisten — the unmount cleanup has already run by then.
  const disposedRef = useRef(false);

  const importing = status.kind === "importing";
  const quoteValid = isValidSingleByteChar(quote);

  const buildOptions = useCallback((): ImportOptions => {
    const nullToken = nullMode === "none" ? null : nullMode === "empty" ? "" : nullCustom;
    return { delimiter, quote, hasHeader, nullToken, encoding };
  }, [delimiter, quote, hasHeader, nullMode, nullCustom, encoding]);

  // Fetch destination columns once for the mapping UI.
  useEffect(() => {
    let cancelled = false;
    api
      .describeTable(sessionId, database, table)
      .then((cols) => {
        if (!cancelled) setTableColumns(cols);
      })
      .catch((e) => {
        if (!cancelled) setPreviewError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table]);

  // Reload the preview whenever the file or parsing options change.
  useEffect(() => {
    if (!path) {
      setPreview(null);
      return;
    }
    // An invalid quote would make the backend parser misbehave; skip the
    // preview fetch until it is corrected (the field shows its own error).
    if (!quoteValid) return;
    let cancelled = false;
    setLoadingPreview(true);
    setPreviewError(null);
    api
      .parseCsvPreview(path, buildOptions())
      .then((p) => {
        if (cancelled) return;
        setPreview(p);
        if (tableColumns) setMapping(autoMap(tableColumns, p.headers, hasHeader));
      })
      .catch((e) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingPreview(false);
      });
    return () => {
      cancelled = true;
    };
    // buildOptions captures every parsing option; tableColumns drives auto-map.
  }, [path, buildOptions, tableColumns, hasHeader, quoteValid]);

  // Detach the event listener on unmount.
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  const handleBrowse = async () => {
    const selected = await open({
      multiple: false,
      title: t("importPickFileTitle"),
      filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
    });
    if (typeof selected === "string" && selected) {
      setPath(selected);
      setStatus({ kind: "idle" });
    }
  };

  const csvColumnLabel = useCallback(
    (index: number): string => {
      if (hasHeader && preview?.headers[index]) {
        return `${index + 1}. ${preview.headers[index]}`;
      }
      return t("importColumnNumbered", { n: index + 1 });
    },
    [hasHeader, preview, t],
  );

  const mappingEntries = useMemo<ColumnMapping[]>(() => {
    return Object.entries(mapping)
      .filter(([, idx]) => idx !== null && idx !== undefined)
      .map(([column, idx]) => ({ column, csvIndex: idx as number }));
  }, [mapping]);

  const handleImport = async () => {
    if (!path || mappingEntries.length === 0 || !quoteValid) return;
    const streamId = newStreamId();
    streamIdRef.current = streamId;
    setStatus({ kind: "importing", inserted: 0, total: 0 });

    if (unlistenRef.current) unlistenRef.current();
    const unlisten = await listenImportStream(streamId, {
      onStarted: (e) => setStatus({ kind: "importing", inserted: 0, total: e.total }),
      onProgress: (e) =>
        setStatus({ kind: "importing", inserted: e.inserted, total: e.total }),
      onDone: (e) => {
        toast.success(t("importSuccess", { inserted: e.inserted, ms: e.elapsedMs }));
        setStatus({ kind: "idle" });
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
        onImported();
      },
      onError: (e) => {
        setStatus({ kind: "error", message: e.error });
        toast.error(e.error);
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
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
      await api.importCsv({
        sessionId,
        streamId,
        database,
        table,
        path,
        options: buildOptions(),
        mapping: mappingEntries,
      });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    }
  };

  const handleCancelImport = async () => {
    const sid = streamIdRef.current;
    if (sid) {
      try {
        await api.cancelStream(sid);
      } catch {
        /* best-effort */
      }
    }
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setStatus({ kind: "error", message: t("importCancelled") });
  };

  const percent =
    status.kind === "importing" && status.total > 0
      ? Math.min(100, Math.round((status.inserted / status.total) * 100))
      : 0;

  return (
    <Modal
      width="680px"
      onClose={onClose}
      closeOnInteractOutside={!importing}
      closeOnEscape={!importing}
    >
      <ModalHeader onClose={onClose} closeLabel={t("importClose")} closeDisabled={importing}>
        {t("importTitle", { table })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="var(--space-4)">
        <FormSection>
          <FieldLabel htmlFor="import-path">{t("importFile")}</FieldLabel>
          <PathRow>
            <Input
              id="import-path"
              flex="1"
              minW={0}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("importFilePlaceholder")}
              disabled={importing}
            />
            <Button type="button" onClick={handleBrowse} disabled={importing}>
              {t("importBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        <FormSection flexDirection="row" flexWrap="wrap" gap="14px" alignItems="flex-end">
          <chakra.div display="flex" flexDirection="column" gap="6px">
            <FieldLabel htmlFor="import-encoding">{t("importEncoding")}</FieldLabel>
            <Select
              id="import-encoding"
              minW="140px"
              value={encoding}
              onChange={(e) => setEncoding(e.target.value)}
              disabled={importing}
            >
              {ENCODINGS.map((enc) => (
                <option key={enc} value={enc}>
                  {enc}
                </option>
              ))}
            </Select>
          </chakra.div>

          <chakra.div display="flex" flexDirection="column" gap="6px">
            <FieldLabel htmlFor="import-delimiter">{t("importDelimiter")}</FieldLabel>
            <Select
              id="import-delimiter"
              minW="140px"
              value={delimiter}
              onChange={(e) => setDelimiter(e.target.value as DelimiterChoice)}
              disabled={importing}
            >
              <option value=",">{t("importDelimiterComma")}</option>
              <option value={"\t"}>{t("importDelimiterTab")}</option>
              <option value=";">{t("importDelimiterSemicolon")}</option>
            </Select>
          </chakra.div>

          <chakra.div display="flex" flexDirection="column" gap="6px">
            <FieldLabel htmlFor="import-quote">{t("importQuote")}</FieldLabel>
            <Input
              id="import-quote"
              css={{ width: "64px" }}
              type="text"
              value={quote}
              onChange={(e) => setQuote(e.target.value)}
              disabled={importing}
              aria-invalid={!quoteValid}
              aria-describedby={quoteValid ? undefined : "import-quote-error"}
            />
          </chakra.div>

          <chakra.div display="flex" flexDirection="column" gap="6px">
            <FieldLabel htmlFor="import-null">{t("importNull")}</FieldLabel>
            <Select
              id="import-null"
              minW="140px"
              value={nullMode}
              onChange={(e) => setNullMode(e.target.value as NullMode)}
              disabled={importing}
            >
              <option value="empty">{t("importNullEmpty")}</option>
              <option value="custom">{t("importNullCustom")}</option>
              <option value="none">{t("importNullNone")}</option>
            </Select>
            {nullMode === "custom" && (
              <Input
                css={{ width: "64px" }}
                type="text"
                value={nullCustom}
                onChange={(e) => setNullCustom(e.target.value)}
                disabled={importing}
                aria-label={t("importNullCustom")}
              />
            )}
          </chakra.div>

          <chakra.div display="flex" flexDirection="row" alignItems="center" gap="6px">
            <Switch
              checked={hasHeader}
              onChange={setHasHeader}
              disabled={importing}
              label={t("importHasHeader")}
            />
          </chakra.div>
        </FormSection>

        {!quoteValid && (
          <ErrorNote id="import-quote-error">
            {t("importQuote")}: {t("importQuoteInvalid")}
          </ErrorNote>
        )}
        {previewError && <ErrorNote>{previewError}</ErrorNote>}
        {loadingPreview && (
          /* プレビュー読み込み中のインジケータ: Spinner とテキストを横並びにして
             視覚的なフィードバックを追加する。 */
          <chakra.div display="inline-flex" alignItems="center" gap="1.5" color="app.textMuted">
            <Spinner size={13} />
            {t("importLoadingPreview")}
          </chakra.div>
        )}

        {preview && tableColumns && (
          <FormSection>
            <FieldLabel as="div">{t("importMappingTitle")}</FieldLabel>
            <chakra.div
              display="grid"
              gridTemplateColumns="repeat(auto-fill, minmax(280px, 1fr))"
              gap="var(--space-2)"
            >
              {tableColumns.map((col) => (
                <chakra.div
                  display="flex"
                  alignItems="center"
                  gap="var(--space-2)"
                  key={col.name}
                >
                  <chakra.span
                    flex="0 0 40%"
                    fontSize="md"
                    fontFamily="mono"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                    title={col.data_type}
                  >
                    {col.name}
                    {col.key === "PRI" && (
                      <chakra.span
                        fontSize="xs"
                        ml="var(--space-1)"
                        color="app.cell.date"
                        title={t("colPkTitle")}
                      >
                        <Icon name="key" />
                      </chakra.span>
                    )}
                  </chakra.span>
                  <Select
                    flex="1"
                    minW={0}
                    value={mapping[col.name] ?? ""}
                    onChange={(e) =>
                      setMapping((prev) => ({
                        ...prev,
                        [col.name]: e.target.value === "" ? null : Number(e.target.value),
                      }))
                    }
                    disabled={importing}
                  >
                    <option value="">{t("importSkipColumn")}</option>
                    {preview.headers.map((_, idx) => (
                      <option key={idx} value={idx}>
                        {csvColumnLabel(idx)}
                      </option>
                    ))}
                  </Select>
                </chakra.div>
              ))}
            </chakra.div>
          </FormSection>
        )}

        {preview && preview.rows.length > 0 && (
          <FormSection>
            <FieldLabel as="div">
              {t("importPreviewTitle")}
              {preview.truncated && (
                <chakra.span color="app.textMuted"> {t("importPreviewTruncated")}</chakra.span>
              )}
            </FieldLabel>
            <chakra.div
              overflow="auto"
              maxH="220px"
              border="1px solid"
              borderColor="app.border"
              borderRadius="md"
            >
              <chakra.table
                borderCollapse="collapse"
                fontSize="sm"
                width="max-content"
                minW="100%"
                css={{
                  "& th, & td": {
                    border: "1px solid var(--border)",
                    padding: "4px 8px",
                    textAlign: "left",
                    whiteSpace: "nowrap",
                    maxWidth: "240px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                  "& th": { background: "var(--bg-toolbar)", position: "sticky", top: 0 },
                }}
              >
                <thead>
                  <tr>
                    {preview.headers.map((h, idx) => (
                      <th key={idx}>{hasHeader ? h : csvColumnLabel(idx)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 10).map((row, ri) => (
                    <tr key={ri}>
                      {preview.headers.map((_, ci) => (
                        <td key={ci}>{row[ci] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </chakra.table>
            </chakra.div>
          </FormSection>
        )}

        {status.kind === "importing" && (
          <chakra.div
            role="status"
            aria-live="polite"
            display="flex"
            flexDirection="column"
            gap="6px"
          >
            <chakra.div h="8px" borderRadius="sm" bg="app.surfaceMuted" overflow="hidden">
              <motion.div
                style={{ height: "100%", background: "var(--accent)" }}
                animate={{ width: `${percent}%` }}
                transition={transitions.progress}
              />
            </chakra.div>
            <chakra.div fontSize="sm" color="app.textMuted">
              {t("importProgress", { inserted: status.inserted, total: status.total })}
            </chakra.div>
          </chakra.div>
        )}
        {status.kind === "error" && <ErrorNote>{status.message}</ErrorNote>}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        {importing ? (
          <PressableButton type="button" variant="warning" onClick={handleCancelImport}>{t("importStop")}</PressableButton>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>{t("importClose")}</Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={importing}
          onClick={handleImport}
          disabled={importing || !path || mappingEntries.length === 0 || !quoteValid}
        >
          {importing ? t("importImporting") : t("importExecute")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
