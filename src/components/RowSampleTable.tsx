import { chakra } from "@chakra-ui/react";
import type { CellValue } from "../api/tauri";
import { useT } from "../i18n";
import type { RowSampleState } from "../useRowSample";

function cellText(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * 変更前の先頭数行 (`useRowSample` の結果) を読み取り専用の小さな表で見せる (#1626)。
 * 置換の「変更前 → 変更後」、プリフライトの影響行、一括編集のプレビューで共通に使う。
 */
export function RowSampleTable({
  state,
  label,
  testId,
}: {
  state: RowSampleState | null;
  label: string;
  testId?: string;
}) {
  const t = useT();
  if (!state) return null;
  if (state.status === "loading") {
    return (
      <chakra.div color="app.textMuted" textStyle="caption" data-testid={testId}>
        {t("rowSampleLoading")}
      </chakra.div>
    );
  }
  if (state.status === "error") {
    return (
      <chakra.div color="app.textError" textStyle="caption" data-testid={testId}>
        {t("rowSampleError", { error: state.error })}
      </chakra.div>
    );
  }
  if (state.rows.length === 0) {
    return (
      <chakra.div color="app.textMuted" textStyle="caption" data-testid={testId}>
        {t("rowSampleEmpty")}
      </chakra.div>
    );
  }
  return (
    <chakra.div overflowX="auto" maxH="200px" overflowY="auto" data-testid={testId}>
      <chakra.table
        aria-label={label}
        fontFamily="mono"
        textStyle="caption"
        borderCollapse="collapse"
        w="100%"
      >
        <thead>
          <tr>
            {state.columns.map((c, i) => (
              <chakra.th key={i} textAlign="left" px="2" py="1" color="app.textMuted" fontWeight={600}>
                {c}
              </chakra.th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((v, ci) => (
                <chakra.td
                  key={ci}
                  px="2"
                  py="1"
                  borderTopWidth="1px"
                  borderColor="app.border"
                  color={v === null ? "app.textMuted" : "app.text"}
                  wordBreak="break-all"
                >
                  {cellText(v)}
                </chakra.td>
              ))}
            </tr>
          ))}
        </tbody>
      </chakra.table>
    </chakra.div>
  );
}
