import { PreviewResult } from "../api/tauri";
import { useT } from "../i18n";
import { DataGrid } from "./ResultGrid";

interface Props {
  result: PreviewResult;
  rowLimit: number;
}

export function PreviewGrid({ result, rowLimit }: Props) {
  const t = useT();
  const hasSnapshots = result.columns.length > 0;

  return (
    <div className="preview">
      <div className="preview-banner">
        <span className="preview-banner-dot" aria-hidden />
        <span className="preview-banner-text">{t("previewBanner")}</span>
      </div>
      <div className="preview-meta">
        {result.target_table ? (
          <span className="preview-target">
            {t("previewTargetTable", { table: result.target_table })}
          </span>
        ) : (
          <span className="preview-target preview-target-missing">
            {t("previewNoTarget")}
          </span>
        )}
        <span className="preview-affected">
          {t("previewRowsAffected", { rows: result.rows_affected, ms: result.elapsed_ms })}
        </span>
        {result.truncated && (
          <span className="preview-truncated">
            {t("previewTruncated", { limit: rowLimit })}
          </span>
        )}
      </div>

      {hasSnapshots && (
        <div className="preview-grids">
          <section className="preview-pane preview-before">
            <header className="preview-pane-header">{t("previewBefore")}</header>
            <div className="preview-pane-body">
              {result.before_rows.length === 0 ? (
                <div className="preview-empty">{t("previewEmptyBefore")}</div>
              ) : (
                <DataGrid columns={result.columns} rows={result.before_rows} />
              )}
            </div>
          </section>
          <section className="preview-pane preview-after">
            <header className="preview-pane-header">{t("previewAfter")}</header>
            <div className="preview-pane-body">
              {result.after_rows.length === 0 ? (
                <div className="preview-empty">{t("previewEmptyAfter")}</div>
              ) : (
                <DataGrid columns={result.columns} rows={result.after_rows} />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
