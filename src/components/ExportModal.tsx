import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, CellValue, Column, ExportFormat } from "../api/tauri";
import { useT } from "../i18n";
import { useToast } from "./Toast";

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
  | { kind: "error"; message: string };

export function ExportModal({ columns, rows, database, table, partial, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const initialBasename = useMemo(() => defaultBasename(database, table), [database, table]);
  const [path, setPath] = useState<string>(`${initialBasename}${extensionFor("csv")}`);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const isSaving = status.kind === "saving";

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

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("exportTitle")}</h2>
          <button
            className="icon"
            onClick={onClose}
            aria-label={t("exportClose")}
            title={t("exportClose")}
          >
            ✕
          </button>
        </header>

        <div className="modal-body export-body">
          <div className="export-rowcount">{t("exportRowCount", { rows: rows.length })}</div>
          {partial && (
            <div className="export-warning" role="status">
              {t("exportPartialWarning")}
            </div>
          )}
          <section className="export-section">
            <div className="export-label">{t("exportFormat")}</div>
            <div className="export-format-row" role="radiogroup" aria-label={t("exportFormat")}>
              <label className={`export-format-option ${format === "csv" ? "active" : ""}`}>
                <input
                  type="radio"
                  name="export-format"
                  value="csv"
                  checked={format === "csv"}
                  onChange={() => setFormat("csv")}
                  disabled={isSaving}
                />
                <span>{t("exportFormatCsv")}</span>
              </label>
              <label className={`export-format-option ${format === "json" ? "active" : ""}`}>
                <input
                  type="radio"
                  name="export-format"
                  value="json"
                  checked={format === "json"}
                  onChange={() => setFormat("json")}
                  disabled={isSaving}
                />
                <span>{t("exportFormatJson")}</span>
              </label>
            </div>
          </section>

          <section className="export-section">
            <label className="export-label" htmlFor="export-path">
              {t("exportSavePath")}
            </label>
            <div className="export-path-row">
              <input
                id="export-path"
                className="export-path-input"
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("exportSavePathPlaceholder")}
                disabled={isSaving}
              />
              <button type="button" onClick={handleBrowse} disabled={isSaving}>
                {t("exportBrowse")}
              </button>
            </div>
          </section>

          {status.kind === "error" && (
            <div className="export-error">{t("exportError", { error: status.message })}</div>
          )}
        </div>

        <div className="modal-footer">
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={isSaving}>
            {t("exportCancel")}
          </button>
          <button
            className="primary"
            onClick={handleExport}
            disabled={isSaving || !path.trim()}
          >
            {isSaving ? t("exportSaving") : t("exportExecute")}
          </button>
        </div>
      </div>
    </div>
  );
}
