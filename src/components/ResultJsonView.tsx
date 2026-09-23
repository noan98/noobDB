import { useMemo } from "react";
import { Box, chakra, Flex } from "@chakra-ui/react";
import type { QueryResult } from "../api/tauri";
import { useT } from "../i18n";
import { useSettings } from "../settings";
import { copyToClipboard } from "./clipboard";
import { resolveMaskedColumns } from "./columnMask";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { JsonTreeView } from "./JsonTreeView";
import { serializeJson } from "./jsonTree";
import { gridViewStateKeyFrom, readStoredGridView, resultShapeSizingKey } from "./gridViewState";
import { resultToJson } from "./resultJson";
import { ResultViewSwitch, type ResultViewKind } from "./ResultViewSwitch";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

interface Props {
  result: QueryResult;
  /** グリッドと同じ結果シェイプキーでマスクの上書き (#1069) を引くための DB / テーブル。 */
  database?: string | null;
  table?: string | null;
  onChangeView: (view: ResultViewKind) => void;
}

/**
 * 結果パネルの JSON ビュー (#1113)。結果を「行オブジェクトの配列」として、セル値
 * ビューアと同じ `JsonTreeView` (#1026) で閲覧する。展開したノードだけを描画し、
 * 子は 200 件ずつ追加するので大きな結果でも固まらない。変換は `resultJson.ts`。
 *
 * 機微カラム (#1069) はグリッドと同じ設定 + 列ごとの上書きで判定し、常に伏せ字で
 * 出す (このビューには一時 reveal の導線を持たせない)。読み取り専用で、DB への
 * 書き込み経路は持たない。
 */
export function ResultJsonView({ result, database, table, onChangeView }: Props) {
  const t = useT();
  const toast = useToast();
  const { columnMaskEnabled, columnMaskPatterns } = useSettings();

  const maskedCols = useMemo(() => {
    const key = gridViewStateKeyFrom(resultShapeSizingKey(result.columns, database, table));
    const overrides = readStoredGridView(key).masks ?? {};
    return resolveMaskedColumns(
      result.columns.map((c) => c.name),
      { enabled: columnMaskEnabled, patterns: columnMaskPatterns, overrides },
    );
  }, [result.columns, database, table, columnMaskEnabled, columnMaskPatterns]);

  const json = useMemo(
    () => resultToJson(result.columns, result.rows, { maskedCols }),
    [result.columns, result.rows, maskedCols],
  );

  const copyAll = async () => {
    const ok = await copyToClipboard(serializeJson(json.root, 2));
    if (ok) toast.success(t("resultJsonCopied", { rows: json.shown }));
    else toast.error(t("clipboardCopyFailed"));
  };

  return (
    <Flex direction="column" h="100%" minH={0} minW={0}>
      <Flex
        align="center"
        gap="2.5"
        px="3"
        py="2"
        flex="none"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        flexWrap="wrap"
        fontSize="sm"
      >
        <ResultViewSwitch value="json" onChange={onChangeView} />
        <chakra.span color="app.textMuted" textStyle="numeric">
          {json.truncated
            ? t("resultJsonTruncated", { shown: json.shown, total: json.total })
            : t("resultJsonRows", { rows: json.total })}
        </chakra.span>
        <chakra.span flex="1" />
        <Tooltip label={t("resultJsonCopyTitle")}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void copyAll()}
            disabled={json.shown === 0}
          >
            <Icon name="copy" size={ICON_SIZES.sm} />
            {t("resultJsonCopy")}
          </Button>
        </Tooltip>
      </Flex>
      {json.total === 0 ? (
        <Flex flex="1" minH={0} align="center" justify="center">
          <EmptyState icon="braces" title={t("resultJsonEmpty")} />
        </Flex>
      ) : (
        <Box flex="1" minH={0} overflow="auto" px="3" py="2">
          <JsonTreeView root={json.root} />
        </Box>
      )}
    </Flex>
  );
}
