import { chakra } from "@chakra-ui/react";
import type { CellValue } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
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
  highlightColumns,
}: {
  state: RowSampleState | null;
  label: string;
  testId?: string;
  /** 強調する列名 (大小無視)。UPDATE の SET 対象列を見せるのに使う (#1881)。 */
  highlightColumns?: readonly string[];
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
  const hl = new Set((highlightColumns ?? []).map((c) => c.toLowerCase()));
  const isHl = (ci: number) => hl.has((state.columns[ci] ?? "").toLowerCase());
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
              <chakra.th
                key={i}
                textAlign="left"
                px="2"
                py="1"
                color={isHl(i) ? semanticColorToken("warning", "text") : "app.textMuted"}
                bg={isHl(i) ? semanticColorToken("warning", "subtle") : undefined}
                fontWeight={600}
                data-highlight={isHl(i) ? "true" : undefined}
              >
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
                  bg={isHl(ci) ? semanticColorToken("warning", "subtle") : undefined}
                  data-highlight={isHl(ci) ? "true" : undefined}
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
