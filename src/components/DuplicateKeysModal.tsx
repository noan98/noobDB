import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api, type CellValue, type Column, type ResultDuplicateKeys } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { findDuplicateKeys } from "./duplicateKeys";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Spinner } from "./Spinner";
import { Button, Checkbox } from "./ui";

/**
 * 結果の重複キー検出ダイアログ (#1628)。選んだ列の組み合わせで同じ値を持つ行の
 * グループ数・行数と上位の重複値を示し、重複行だけにグリッドを絞り込める。
 *
 * 結果ハンドルがあれば保持済みの行にバックエンドで検出させ (`result_duplicate_keys`)、無い
 * 結果 (小さい結果・編集後・load-more 後など) やハンドルが破棄済みのときは、手元の行に
 * 同じ意味論の JS 実装 (`duplicateKeys.ts`) で検出する。どちらも再実行や SQL の書き換えは
 * 要らず、DB へは何も書かない。
 */
interface Props {
  columns: Column[];
  rows: CellValue[][];
  /** 結果ハンドル。無ければ JS で検出する。 */
  resultId: string | null;
  /** 最初にチェックしておく列 (開いた列)。 */
  initialCols: number[];
  /** 機微カラムの表示マスク (#1069) 中の列。上位の重複値が実値を表示してしまうので選べなくする。 */
  maskedCols?: boolean[] | null;
  /** 重複行の絞り込みが今かかっているか (解除ボタンの出し分け)。 */
  filterActive: boolean;
  /** 重複行のインデックスで絞り込む。 */
  onShowDuplicates: (rowIndices: number[]) => void;
  onClearFilter: () => void;
  onClose: () => void;
}

export function DuplicateKeysModal({
  columns,
  rows,
  resultId,
  initialCols,
  maskedCols,
  filterActive,
  onShowDuplicates,
  onClearFilter,
  onClose,
}: Props) {
  const t = useT();
  const [selected, setSelected] = useState<number[]>(initialCols.filter((i) => !maskedCols?.[i]));
  const [result, setResult] = useState<ResultDuplicateKeys | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = useCallback(
    async (cols: number[]) => {
      if (cols.length === 0) return;
      const my = ++seq.current;
      setRunning(true);
      setError(null);
      try {
        let out: ResultDuplicateKeys | null = null;
        if (resultId) {
          // ハンドルが破棄済み (null / エラー) のときは手元の行で検出し直す。
          out = await api.resultDuplicateKeys(resultId, cols).catch(() => null);
        }
        if (!out) out = findDuplicateKeys(rows, cols);
        if (my === seq.current) setResult(out);
      } catch (e) {
        if (my === seq.current) {
          setResult(null);
          setError(String(e));
        }
      } finally {
        if (my === seq.current) setRunning(false);
      }
    },
    [resultId, rows],
  );

  // 開いたときと列の選択が変わったときに自動で検出する (保持済みの行だけで完結するので軽い)。
  useEffect(() => {
    void run(selected);
  }, [run, selected]);

  const toggle = (idx: number) =>
    setSelected((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx].sort((a, b) => a - b),
    );

  const keyLabel = useMemo(() => selected.map((i) => columns[i]?.name ?? "").join(", "), [selected, columns]);

  return (
    <Modal
      onSubmit={() => void run(selected)}
      submitDisabled={selected.length === 0}
      width="560px"
      onClose={onClose}
    >
      <ModalHeader onClose={onClose} closeLabel={t("dupKeysClose")}>
        {t("dupKeysTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <FormSection>
          <FieldLabel as="div">{t("dupKeysColumns")}</FieldLabel>
          <chakra.div display="flex" flexWrap="wrap" gap="3" maxH="140px" overflowY="auto">
            {columns.map((c, i) => (
              <chakra.label
                key={`${i}:${c.name}`}
                display="inline-flex"
                alignItems="center"
                gap="1.5"
                cursor="pointer"
                userSelect="none"
              >
                <Checkbox
                  checked={selected.includes(i)}
                  disabled={!!maskedCols?.[i]}
                  onChange={() => toggle(i)}
                />
                <chakra.span fontFamily="mono">{c.name}</chakra.span>
                {maskedCols?.[i] && <chakra.span textStyle="caption">{t("dupKeysMasked")}</chakra.span>}
              </chakra.label>
            ))}
          </chakra.div>
          <chakra.span textStyle="caption">
            {t("dupKeysScopeHint", { rows: rows.length.toLocaleString() })}
          </chakra.span>
        </FormSection>

        {selected.length === 0 && <Callout tone="warning">{t("dupKeysPickColumn")}</Callout>}
        {running && (
          <chakra.div display="flex" alignItems="center" gap="2">
            <Spinner size={14} />
            <chakra.span textStyle="caption">{t("dupKeysRunning")}</chakra.span>
          </chakra.div>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        {result && selected.length > 0 && (
          <>
            <Callout
              tone={result.groupCount === 0 ? "success" : "warning"}
              role="status"
              data-testid="dup-keys-summary"
            >
              {result.groupCount === 0
                ? t("dupKeysNone", { columns: keyLabel, keys: result.distinctKeys.toLocaleString() })
                : t("dupKeysSummary", {
                    groups: result.groupCount.toLocaleString(),
                    rows: result.duplicateRows.toLocaleString(),
                    extra: result.extraRows.toLocaleString(),
                  })}
            </Callout>
            {result.nullKeyRows > 0 && (
              <chakra.span textStyle="caption">
                {t("dupKeysNullSkipped", { count: result.nullKeyRows.toLocaleString() })}
              </chakra.span>
            )}
            {result.top.length > 0 && (
              <FormSection>
                <FieldLabel as="div">{t("dupKeysTop")}</FieldLabel>
                <chakra.ul
                  listStyleType="none"
                  margin={0}
                  padding={0}
                  display="flex"
                  flexDirection="column"
                  gap="1"
                >
                  {result.top.map((g) => (
                    <chakra.li
                      key={g.firstRow}
                      display="flex"
                      justifyContent="space-between"
                      gap="3"
                      fontFamily="mono"
                      fontSize="sm"
                    >
                      <chakra.span overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                        {g.values.join(" | ")}
                      </chakra.span>
                      <chakra.span flexShrink={0} color="app.textMuted">
                        {t("dupKeysCount", { count: g.count.toLocaleString() })}
                      </chakra.span>
                    </chakra.li>
                  ))}
                </chakra.ul>
              </FormSection>
            )}
            {result.indicesTruncated && (
              <chakra.span textStyle="caption">
                {t("dupKeysIndicesTruncated", { count: result.rowIndices.length.toLocaleString() })}
              </chakra.span>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        {filterActive ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onClearFilter();
              onClose();
            }}
          >
            {t("dupKeysClearFilter")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            disabled={!result || result.groupCount === 0}
            onClick={() => {
              if (result) onShowDuplicates(result.rowIndices);
              onClose();
            }}
          >
            {t("dupKeysShowOnly")}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("dupKeysClose")}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={selected.length === 0 || running}
          onClick={() => void run(selected)}
        >
          {t("dupKeysRun")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
