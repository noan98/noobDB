import { chakra, Box, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  SHORTCUTS,
  SHORTCUT_CATEGORY_LABEL,
  SHORTCUT_CATEGORY_ORDER,
  type ShortcutCategory,
} from "../shortcuts";
import { Modal, ModalHeader, ModalBody } from "./Modal";

/**
 * `?` キーで開くキーボードショートカット チートシート オーバーレイ (#448)。
 *
 * - ショートカット定義は `shortcuts.ts` の単一ソース (`SHORTCUTS`) を参照し、
 *   `HelpView` のショートカット節と二重管理にならない。
 * - シェルは共通 `Modal` を流用するため、フォーカストラップ・Esc クローズ・
 *   バックドロップ・開閉アニメ (Motion `variants.dialog`) を自前で持たない。
 *   `prefers-reduced-motion: reduce` の抑制も `Modal` 経由で効く (Epic #370)。
 * - `App.tsx` 側のグローバルキーハンドラが、入力欄/エディタにフォーカスが無い
 *   ときだけ `?` を捕捉してこれを開く (誤発火防止)。閉じるのは親のアンマウント。
 *
 * カテゴリ (グローバル / エディタ / 結果グリッド / タブ) ごとに見出しを付けて
 * 一覧表示する。空カテゴリは描画しない。
 */
interface ShortcutCheatSheetProps {
  onClose: () => void;
}

export function ShortcutCheatSheet({ onClose }: ShortcutCheatSheetProps) {
  const t = useT();

  return (
    <Modal onClose={onClose} width="560px">
      <ModalHeader onClose={onClose} closeLabel={t("cheatSheetClose")}>
        {t("cheatSheetTitle")}
      </ModalHeader>
      <ModalBody>
        <Flex direction="column" gap="var(--space-4)">
          {SHORTCUT_CATEGORY_ORDER.map((category) => {
            const items = SHORTCUTS.filter((s) => s.category === category);
            if (items.length === 0) return null;
            return (
              <Box key={category}>
                <Box
                  pb="1.5"
                  fontSize="xs"
                  fontWeight={700}
                  textTransform="uppercase"
                  letterSpacing="0.06em"
                  color="app.textMuted"
                >
                  {t(SHORTCUT_CATEGORY_LABEL[category as ShortcutCategory])}
                </Box>
                <Flex direction="column">
                  {items.map((s) => (
                    <Flex
                      key={s.keysKey}
                      align="center"
                      justify="space-between"
                      gap="var(--space-3)"
                      py="1.5"
                      borderBottomWidth="1px"
                      borderBottomColor="app.borderSubtle"
                    >
                      <chakra.span fontSize="sm" color="app.text">
                        {t(s.descKey)}
                      </chakra.span>
                      <chakra.kbd
                        flexShrink={0}
                        px="1.5"
                        py="1px"
                        borderRadius="sm"
                        borderWidth="1px"
                        borderColor="app.border"
                        bg="app.surface"
                        fontSize="xs"
                        fontFamily="inherit"
                        color="app.textSecondary"
                        whiteSpace="nowrap"
                      >
                        {t(s.keysKey)}
                      </chakra.kbd>
                    </Flex>
                  ))}
                </Flex>
              </Box>
            );
          })}
        </Flex>
      </ModalBody>
    </Modal>
  );
}
