import { useState } from "react";
import { Box, chakra } from "@chakra-ui/react";

import type { SandboxRecord } from "../api/tauri";
import { useT } from "../i18n";
import { sandboxProfileId } from "../sandbox";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { Icon, ICON_SIZES } from "./Icon";
import { TreeBadge, TreeChevron } from "./tree";
import { Tooltip } from "./Tooltip";

/**
 * サンドボックス (壊せる砂場、#747) の一覧セクション。`ConnectionList` の
 * 通常のプロファイルツリー (ドラッグ並べ替え・グループ化・編集/複製/削除) とは
 * 完全に独立させている — サンドボックスは `save_profile` を経由しない非永続の
 * 合成プロファイルなので、それらの機構 (特に `reorderProfiles` の permutation
 * 検証) に混ぜると壊れる。開く/切替は既存の `openConnections` 登録機構をその
 * まま再利用する (`onOpen` が渡す合成プロファイルで通常の接続と同じ経路を通る)
 * ため、アクティブ/バックグラウンド接続中の判定は `activeProfileId` /
 * `openProfileIds` をそのまま使える。
 */
export function SandboxSection({
  sandboxes,
  activeProfileId,
  openProfileIds,
  connectingId,
  onOpen,
  onReview,
  onDiscard,
}: {
  sandboxes: SandboxRecord[];
  activeProfileId: string | null;
  openProfileIds?: ReadonlySet<string>;
  connectingId: string | null;
  onOpen: (record: SandboxRecord) => void;
  onReview: (record: SandboxRecord) => void;
  onDiscard: (record: SandboxRecord) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuEntry[] } | null>(null);

  if (sandboxes.length === 0) return null;

  return (
    <Box borderTop="1px solid" borderColor="app.borderSubtle" py="1.5">
      <chakra.button
        type="button"
        display="flex"
        alignItems="center"
        gap="1.5"
        width="100%"
        px="2.5"
        py="1"
        fontSize="xs"
        fontWeight={600}
        color="app.textSecondary"
        bg="transparent"
        border="none"
        cursor="pointer"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <TreeChevron transform={open ? "rotate(90deg)" : undefined} aria-hidden>▸</TreeChevron>
        <Icon name="flask" size={ICON_SIZES.sm} />
        <chakra.span flex="1" textAlign="left">{t("sandboxSectionTitle")}</chakra.span>
        <TreeBadge textTransform="none" letterSpacing="0">{sandboxes.length}</TreeBadge>
      </chakra.button>
      {open && (
        <Box role="tree" aria-label={t("sandboxSectionTitle")}>
          {sandboxes.map((record) => {
            const pid = sandboxProfileId(record.id);
            const isActive = activeProfileId === pid;
            const isOpenElsewhere = !isActive && !!openProfileIds?.has(pid);
            const isConnecting = connectingId === pid;
            return (
              <chakra.button
                key={record.id}
                type="button"
                role="treeitem"
                aria-selected={isActive}
                display="flex"
                alignItems="center"
                gap="1.5"
                width="100%"
                pl="7"
                pr="2.5"
                py="1.5"
                fontSize="sm"
                textAlign="left"
                bg={isActive ? "app.selectedBg" : "transparent"}
                color="app.text"
                border="none"
                cursor="pointer"
                _hover={{ bg: "app.hover" }}
                onClick={() => onOpen(record)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: t("sandboxMenuReview"), onSelect: () => onReview(record) },
                      { separator: true },
                      {
                        label: t("sandboxMenuDiscard"),
                        danger: true,
                        onSelect: () => {
                          if (confirm(t("sandboxDiscardConfirm", { name: record.name }))) {
                            onDiscard(record);
                          }
                        },
                      },
                    ],
                  });
                }}
              >
                <Icon name="flask" size={ICON_SIZES.sm} />
                <chakra.span
                  flex="1"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  whiteSpace="nowrap"
                  fontFamily="mono"
                >
                  {record.name}
                </chakra.span>
                <Tooltip label={t("sandboxTableCountTitle", { count: record.tables.length })}>
                  <TreeBadge textTransform="none" letterSpacing="0">
                    {record.tables.length}
                  </TreeBadge>
                </Tooltip>
                {isConnecting && (
                  <chakra.span fontSize="2xs" color="app.textMuted">
                    {t("statusBadge_connecting")}
                  </chakra.span>
                )}
                {isOpenElsewhere && !isConnecting && (
                  <chakra.span
                    aria-hidden
                    display="inline-block"
                    width="6px"
                    height="6px"
                    borderRadius="full"
                    bg="app.status.success"
                  />
                )}
              </chakra.button>
            );
          })}
        </Box>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </Box>
  );
}
