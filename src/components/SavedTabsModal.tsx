import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { SavedWorkspaceSummary } from "../savedTabsSummary";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button } from "./ui";

interface Props {
  profileName: string;
  summary: SavedWorkspaceSummary;
  /** この接続が今開いている (保存内容は閉じる / 切断時に現在のタブで上書きされる)。 */
  isActive: boolean;
  /** 保存済みタブだけを消す (接続・現在のタブには触れない)。 */
  onClear: () => void;
  onClose: () => void;
}

const KIND_KEY = {
  table: "savedTabsKindTable",
  query: "savedTabsKindQuery",
  explain: "savedTabsKindExplain",
} as const;

/**
 * 接続ごとの保存済みワークスペース (タブ) を一覧し、保存だけを消せるモーダル (#1630)。
 * 復元確認の「今回は開かない」で残した下書きを、あとから確認して残すか消すか選べる。
 * 破壊的操作 (消去) は左の dangerOutline、右の primary が閉じる (初期フォーカス)。
 */
export function SavedTabsModal({ profileName, summary, isActive, onClear, onClose }: Props) {
  const t = useT();
  return (
    <Modal
      // no-submit: 破壊的な「消去」を Cmd/Ctrl+Enter で誤って実行させない (主アクションは閉じるだけ)
      width="640px"
      onClose={onClose}
    >
      <ModalHeader onClose={onClose} closeLabel={t("savedTabsClose")}>
        {t("savedTabsTitle", { name: profileName })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3">
        {summary.total === 0 ? (
          <chakra.p fontSize="sm" color="app.textMuted" margin={0}>
            {t("savedTabsEmpty")}
          </chakra.p>
        ) : (
          <>
            <chakra.p fontSize="sm" color="app.textMuted" margin={0}>
              {t("savedTabsSummary", { count: summary.total })}
            </chakra.p>
            {summary.panes.map((pane, pi) => (
              <Flex key={pi} direction="column" gap="1" data-testid="saved-tabs-pane">
                {summary.panes.length > 1 && (
                  <chakra.span textStyle="overline" color="app.textSecondary">
                    {t("savedTabsPane", { n: pi + 1 })}
                  </chakra.span>
                )}
                {pane.tabs.map((tab, ti) => (
                  <Flex
                    key={ti}
                    direction="column"
                    gap="0.5"
                    px="2"
                    py="1.5"
                    borderRadius="sm"
                    bg="app.surfaceMuted"
                  >
                    <Flex gap="2" align="baseline" minW={0}>
                      <chakra.span fontSize="sm" fontWeight={600} overflow="hidden" textOverflow="ellipsis">
                        {tab.title}
                      </chakra.span>
                      <chakra.span textStyle="caption" flexShrink={0}>
                        {t(KIND_KEY[tab.kind])}
                        {tab.target ? ` · ${tab.target}` : ""}
                      </chakra.span>
                    </Flex>
                    {tab.sqlHead && (
                      <chakra.code
                        fontFamily="var(--font-mono)"
                        fontSize="xs"
                        color="app.textSecondary"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        whiteSpace="nowrap"
                      >
                        {tab.sqlHead}
                      </chakra.code>
                    )}
                  </Flex>
                ))}
              </Flex>
            ))}
          </>
        )}
        {isActive && <Callout tone="info">{t("savedTabsActiveNote")}</Callout>}
      </ModalBody>
      <ModalFooter>
        <Button
          type="button"
          variant="dangerOutline"
          disabled={summary.total === 0 || isActive}
          onClick={onClear}
        >
          {t("savedTabsClear")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="primary" autoFocus onClick={onClose}>
          {t("savedTabsClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
