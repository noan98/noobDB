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
import { motion } from "motion/react";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import { SuccessCheck } from "./SuccessCheck";

interface Props {
  sessionId: string;
  database: string;
  table: string;
  onClose: () => void;
  /** Called after a successful import so the caller can refresh the grid. */
  onImported: () => void;
}

type DelimiterChoice = "," | "\t" | ";";
type NullMode = "none" | "empty" | "custom";

type Status =
  | { kind: "idle" }
  | { kind: "importing"; inserted: number; total: number }
  | { kind: "success"; inserted: number; ms: number }
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

export function ImportModal({ sessionId, database, table, onClose, onImported }: Props) {
  const t = useT();
  const toast = useToast();
  const [path, setPath] = useState("");
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
    unlistenRef.current = await listenImportStream(streamId, {
      onStarted: (e) => setStatus({ kind: "importing", inserted: 0, total: e.total }),
      onProgress: (e) =>
        setStatus({ kind: "importing", inserted: e.inserted, total: e.total }),
      onDone: (e) => {
        setStatus({ kind: "success", inserted: e.inserted, ms: e.elapsedMs });
        toast.success(t("importSuccess", { inserted: e.inserted, ms: e.elapsedMs }));
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
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={importing ? undefined : onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("importTitle", { table })}</h2>
          <button
            className="icon"
            onClick={onClose}
            disabled={importing}
            aria-label={t("importClose")}
            title={t("importClose")}
          >
            ✕
          </button>
        </header>

        <div className="modal-body import-body">
          <section className="export-section">
            <label className="export-label" htmlFor="import-path">
              {t("importFile")}
            </label>
            <div className="export-path-row">
              <input
                id="import-path"
                className="export-path-input"
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("importFilePlaceholder")}
                disabled={importing}
              />
              <button type="button" onClick={handleBrowse} disabled={importing}>
                {t("importBrowse")}
              </button>
            </div>
          </section>

          <section className="export-section import-options">
            <div className="import-option">
              <label className="export-label" htmlFor="import-encoding">
                {t("importEncoding")}
              </label>
              <select
                id="import-encoding"
                value={encoding}
                onChange={(e) => setEncoding(e.target.value)}
                disabled={importing}
              >
                {ENCODINGS.map((enc) => (
                  <option key={enc} value={enc}>
                    {enc}
                  </option>
                ))}
              </select>
            </div>

            <div className="import-option">
              <label className="export-label" htmlFor="import-delimiter">
                {t("importDelimiter")}
              </label>
              <select
                id="import-delimiter"
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value as DelimiterChoice)}
                disabled={importing}
              >
                <option value=",">{t("importDelimiterComma")}</option>
                <option value={"\t"}>{t("importDelimiterTab")}</option>
                <option value=";">{t("importDelimiterSemicolon")}</option>
              </select>
            </div>

            <div className="import-option">
              <label className="export-label" htmlFor="import-quote">
                {t("importQuote")}
              </label>
              <input
                id="import-quote"
                className="import-quote-input"
                type="text"
                value={quote}
                onChange={(e) => setQuote(e.target.value)}
                disabled={importing}
                aria-invalid={!quoteValid}
                aria-describedby={quoteValid ? undefined : "import-quote-error"}
              />
            </div>

            <div className="import-option">
              <label className="export-label" htmlFor="import-null">
                {t("importNull")}
              </label>
              <select
                id="import-null"
                value={nullMode}
                onChange={(e) => setNullMode(e.target.value as NullMode)}
                disabled={importing}
              >
                <option value="empty">{t("importNullEmpty")}</option>
                <option value="custom">{t("importNullCustom")}</option>
                <option value="none">{t("importNullNone")}</option>
              </select>
              {nullMode === "custom" && (
                <input
                  className="import-quote-input"
                  type="text"
                  value={nullCustom}
                  onChange={(e) => setNullCustom(e.target.value)}
                  disabled={importing}
                  aria-label={t("importNullCustom")}
                />
              )}
            </div>

            <div className="import-option import-header-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={hasHeader}
                  onChange={(e) => setHasHeader(e.target.checked)}
                  disabled={importing}
                />
                <span>{t("importHasHeader")}</span>
              </label>
            </div>
          </section>

          {!quoteValid && (
            <div id="import-quote-error" className="export-error">
              {t("importQuote")}: {t("importQuoteInvalid")}
            </div>
          )}
          {previewError && <div className="export-error">{previewError}</div>}
          {loadingPreview && <div className="muted">{t("importLoadingPreview")}</div>}

          {preview && tableColumns && (
            <section className="export-section">
              <div className="export-label">{t("importMappingTitle")}</div>
              <div className="import-mapping">
                {tableColumns.map((col) => (
                  <div className="import-mapping-row" key={col.name}>
                    <span className="import-mapping-col" title={col.data_type}>
                      {col.name}
                      {col.key === "PRI" && <span className="import-pk" title={t("colPkTitle")}><Icon name="key" /></span>}
                    </span>
                    <select
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
                    </select>
                  </div>
                ))}
              </div>
            </section>
          )}

          {preview && preview.rows.length > 0 && (
            <section className="export-section">
              <div className="export-label">
                {t("importPreviewTitle")}
                {preview.truncated && <span className="muted"> {t("importPreviewTruncated")}</span>}
              </div>
              <div className="import-preview-scroll">
                <table className="import-preview-table">
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
                </table>
              </div>
            </section>
          )}

          {status.kind === "importing" && (
            <div className="import-progress" role="status" aria-live="polite">
              <div className="import-progress-bar">
                <motion.div
                  className="import-progress-fill"
                  animate={{ width: `${percent}%` }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                />
              </div>
              <div className="import-progress-text">
                {t("importProgress", { inserted: status.inserted, total: status.total })}
              </div>
            </div>
          )}
          {status.kind === "success" && (
            <div className="export-success modal-success-mark">
              <SuccessCheck size={22} />
              <span>{t("importSuccess", { inserted: status.inserted, ms: status.ms })}</span>
            </div>
          )}
          {status.kind === "error" && <div className="export-error">{status.message}</div>}
        </div>

        <div className="modal-footer">
          <div style={{ flex: 1 }} />
          {importing ? (
            <button onClick={handleCancelImport}>{t("importStop")}</button>
          ) : (
            <button onClick={onClose}>{t("importClose")}</button>
          )}
          <button
            className="primary"
            onClick={handleImport}
            disabled={importing || !path || mappingEntries.length === 0 || !quoteValid}
          >
            {importing ? t("importImporting") : t("importExecute")}
          </button>
        </div>
      </div>
    </div>
  );
}
