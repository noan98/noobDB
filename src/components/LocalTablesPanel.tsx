import { chakra, Flex } from "@chakra-ui/react";
import type { LocalTableMeta } from "../api/tauri";
import { useT } from "../i18n";
import { useConfirm } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { CodePreview } from "./modalForm";
import { PressableButton } from "./ui";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

/**
 * サイドバーの「ローカル」タブ (#740)。複数接続の結果セットをローカル横断
 * クエリエンジンへ登録したテーブルの一覧を、由来 (元の接続・実行 SQL・登録日時・
 * 件数) 付きで見せる。クエリの実行自体はここでは行わない — 「クエリを開く」で
 * 通常の接続と同じエディタ/グリッド/エクスポートに切り替わる (既存機能の再利用)。
 */
interface Props {
  /** ローカルセッションが (このアプリ起動中に) 一度でも開かれていれば true。 */
  hasSession: boolean;
  /** ローカルセッションが現在アクティブなタブ/接続になっているか。 */
  isActive: boolean;
  tables: LocalTableMeta[];
  loading?: boolean;
  onOpenLocal: () => void;
  onDropTable: (name: string) => void;
  /**
   * 元の SQL を元の接続で流し直し、同じ名前のテーブルへ置き換える (#1541)。
   * 省略時はボタンを出さない。
   */
  onRefetchTable?: (name: string) => void;
  /** 再取得中のテーブル名 (その行のボタンを止める)。 */
  refetchingTable?: string | null;
  onSaveToFile: () => void;
}

function formatFetchedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

export function LocalTablesPanel({
  hasSession,
  isActive,
  tables,
  loading,
  onOpenLocal,
  onDropTable,
  onRefetchTable,
  refetchingTable = null,
  onSaveToFile,
}: Props) {
  const t = useT();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // 登録済みの結果セットは取り消せないので、削除の前に確認を挟む (#1532)。
  const requestDrop = async (name: string) => {
    const ok = await confirm({
      title: t("localPanelDropConfirmTitle"),
      message: t("localPanelDropConfirmBody", { table: name }),
      confirmLabel: t("localPanelDropConfirmOk"),
      tone: "danger",
    });
    if (ok) onDropTable(name);
  };

  return (
    <Flex direction="column" h="100%" minH={0}>
      <Flex
        direction="column"
        gap="1.5"
        px="3"
        py="2.5"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        flexShrink={0}
      >
        <chakra.span fontSize="xs" color="app.textMuted">
          {t("localPanelHint")}
        </chakra.span>
        <Flex gap="1.5">
          <PressableButton
            type="button"
            variant={isActive ? "secondary" : "primary"}
            size="sm"
            onClick={onOpenLocal}
          >
            <Icon name="database" size={ICON_SIZES.sm} />{" "}
            {isActive ? t("localPanelSwitchedIn") : t("localPanelOpen")}
          </PressableButton>
          {hasSession && tables.length > 0 && (
            <Tooltip label={t("localPanelSaveToFileTitle")}>
              <PressableButton type="button" variant="secondary" size="sm" onClick={onSaveToFile}>
                <Icon name="download" size={ICON_SIZES.sm} /> {t("localPanelSaveToFile")}
              </PressableButton>
            </Tooltip>
          )}
        </Flex>
      </Flex>
      <Flex direction="column" flex="1" minH={0} overflowY="auto">
        {!hasSession || tables.length === 0 ? (
          <EmptyState
            icon="database"
            title={t("localPanelEmptyTitle")}
            description={t("localPanelEmptyDescription")}
            compact
          />
        ) : (
          <chakra.ul listStyleType="none" m="0" p="0">
            {tables.map((tbl) => (
              <chakra.li
                key={tbl.name}
                px="3"
                py="2"
                borderBottomWidth="1px"
                borderBottomColor="app.borderSubtle"
                display="flex"
                flexDirection="column"
                gap="0.5"
              >
                <Flex align="center" gap="1.5">
                  <Icon name="table" size={ICON_SIZES.sm} />
                  <chakra.span
                    fontWeight={600}
                    fontSize="sm"
                    color="app.text"
                    flex="1"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {tbl.name}
                  </chakra.span>
                  {onRefetchTable && (
                    <Tooltip
                      label={
                        refetchingTable !== null && refetchingTable !== tbl.name
                          ? t("localPanelRefetchBusy")
                          : t("localPanelRefetchTitle")
                      }
                      focusableWrapper={refetchingTable !== null}
                    >
                      <PressableButton
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={refetchingTable !== null}
                        aria-busy={refetchingTable === tbl.name}
                        aria-label={t("localPanelRefetch", { table: tbl.name })}
                        onClick={() => onRefetchTable(tbl.name)}
                      >
                        {refetchingTable === tbl.name ? (
                          <Spinner size={14} decorative />
                        ) : (
                          <Icon name="refresh" size={ICON_SIZES.sm} />
                        )}
                      </PressableButton>
                    </Tooltip>
                  )}
                  <Tooltip label={t("localPanelDropTable")}>
                    <PressableButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      color="app.textError"
                      _hover={{ color: "app.textError", bg: "app.hover" }}
                      aria-label={t("localPanelDropTable")}
                      onClick={() => void requestDrop(tbl.name)}
                    >
                      <Icon name="trash" size={ICON_SIZES.sm} />
                    </PressableButton>
                  </Tooltip>
                </Flex>
                <chakra.span fontSize="xs" color="app.textMuted">
                  {t("localPanelRowCount", { rows: tbl.row_count.toLocaleString() })}
                  {" · "}
                  {formatFetchedAt(tbl.fetched_at_ms)}
                </chakra.span>
                {tbl.source_profile && (
                  <chakra.span
                    fontSize="xs"
                    color="app.textMuted"
                    overflow="hidden"
                    textOverflow="ellipsis"
                    whiteSpace="nowrap"
                  >
                    {t("localPanelSourceLabel", { name: tbl.source_profile })}
                  </chakra.span>
                )}
                <CodePreview
                  wrap
                  maxH="4.5em"
                  overflow="hidden"
                  fontSize="xs"
                  color="app.textMuted"
                  wordBreak="break-all"
                >
                  {tbl.source_sql}
                </CodePreview>
              </chakra.li>
            ))}
          </chakra.ul>
        )}
        {loading && (
          <chakra.span px="3" py="2" fontSize="xs" color="app.textMuted">
            {t("localPanelLoading")}
          </chakra.span>
        )}
      </Flex>
      {confirmDialog}
    </Flex>
  );
}
