import { useState } from "react";
import { chakra, Box, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import {
  filterShortcuts,
  resolveShortcutBindings,
  SHORTCUTS,
  SHORTCUT_CATEGORY_LABEL,
  SHORTCUT_CATEGORY_ORDER,
  type ShortcutCategory,
} from "../shortcuts";
import { formatCombo } from "../shortcutKeys";
import { useSettings } from "../settings";
import { Kbd } from "./Kbd";
import { Modal, ModalHeader, ModalBody } from "./Modal";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { Input } from "./ui";

/**
 * `?` キーで開くキーボードショートカット チートシート オーバーレイ。
 *
 * - ショートカット定義は `shortcuts.ts` の単一ソース (`SHORTCUTS`) を参照し、
 *   `HelpView` のショートカット節と二重管理にならない。
 * - シェルは共通 `Modal` を流用するため、フォーカストラップ・Esc クローズ・
 *   バックドロップ・開閉アニメ (Motion `variants.dialog`) を自前で持たない。
 *   `prefers-reduced-motion: reduce` の抑制も `Modal` 経由で効く。
 * - `App.tsx` 側のグローバルキーハンドラが、入力欄/エディタにフォーカスが無い
 *   ときだけ `?` を捕捉してこれを開く (誤発火防止)。閉じるのは親のアンマウント。
 *
 * カテゴリ (グローバル / エディタ / 結果グリッド / タブ) ごとに見出しを付けて
 * 一覧表示する。空カテゴリは描画しない。
 */
interface ShortcutCheatSheetProps {
  onClose: () => void;
  /**
   * 再割り当て可能なショートカットの行から、設定のキーバインド節へ移る (#1540)。
   * 渡されたときだけ各行に「変更」ボタンを出す。親がチートシートを閉じて設定を開く。
   */
  onRebind?: () => void;
}

export function ShortcutCheatSheet({ onClose, onRebind }: ShortcutCheatSheetProps) {
  const t = useT();
  // 再割り当て可能なショートカットは解決済みコンボを表示する (#557)。
  const settings = useSettings();
  const resolved = resolveShortcutBindings(settings.shortcutOverrides);
  const [query, setQuery] = useState("");
  const keysText = (s: (typeof SHORTCUTS)[number]) =>
    s.id ? formatCombo(resolved[s.id]) : t(s.keysKey);
  const visible = filterShortcuts(SHORTCUTS, query, (s) => ({
    label: t(s.descKey),
    keys: keysText(s),
  }));

  return (
    <Modal
      // no-submit: 参照画面 (閉じるのみ)
      onClose={onClose} width="560px">
      <ModalHeader onClose={onClose} closeLabel={t("cheatSheetClose")}>
        {t("cheatSheetTitle")}
      </ModalHeader>
      <ModalBody>
        <Flex direction="column" gap="4">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("cheatSheetSearchPlaceholder")}
            aria-label={t("cheatSheetSearchPlaceholder")}
            autoComplete="off"
            data-testid="cheat-sheet-search"
          />
          {visible.length === 0 && (
            <chakra.div textStyle="caption" role="status">
              {t("cheatSheetNoMatches")}
            </chakra.div>
          )}
          {SHORTCUT_CATEGORY_ORDER.map((category) => {
            const items = visible.filter((s) => s.category === category);
            if (items.length === 0) return null;
            return (
              <Box key={category}>
                <Box pb="1.5" textStyle="overline">
                  {t(SHORTCUT_CATEGORY_LABEL[category as ShortcutCategory])}
                </Box>
                <Flex direction="column">
                  {items.map((s) => (
                    <Flex
                      key={s.keysKey}
                      align="center"
                      justify="space-between"
                      gap="3"
                      py="1.5"
                      borderBottomWidth="1px"
                      borderBottomColor="app.borderSubtle"
                    >
                      <chakra.span fontSize="sm" color="app.text">
                        {t(s.descKey)}
                      </chakra.span>
                      <Flex align="center" gap="2" flexShrink={0}>
                        <Kbd flexShrink={0}>{keysText(s)}</Kbd>
                        {onRebind && (
                          // 再割り当て不可 (id なし) の行にも同じ幅の空きを置いて、キー表記の右端を揃える。
                          <chakra.span display="inline-flex" w="6" justifyContent="center">
                            {s.id && (
                              <Tooltip label={t("cheatSheetRebind")}>
                                <chakra.button
                                  type="button"
                                  aria-label={t("cheatSheetRebindFor", { action: t(s.descKey) })}
                                  onClick={onRebind}
                                  display="inline-flex"
                                  alignItems="center"
                                  justifyContent="center"
                                  p="1"
                                  border="none"
                                  bg="transparent"
                                  color="app.textMuted"
                                  borderRadius="sm"
                                  cursor="pointer"
                                  _hover={{ bg: "app.hover", color: "app.text" }}
                                >
                                  <Icon name="pencil" size={ICON_SIZES.sm} />
                                </chakra.button>
                              </Tooltip>
                            )}
                          </chakra.span>
                        )}
                      </Flex>
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
