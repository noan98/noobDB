import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useT } from "../i18n";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { GridViewPresetNameModal } from "./GridViewPresetNameModal";
import {
  GRID_PRESET_MAX,
  type GridViewPreset,
  type GridViewPresetsHandle,
  readStoredGridPresets,
  removeGridPreset,
  upsertGridPreset,
  writeStoredGridPresets,
} from "./gridViewState";
import { Icon, ICON_SIZES } from "./Icon";
import { Tooltip } from "./Tooltip";
import { useToast } from "./Toast";
import { Button } from "./ui";

interface Props {
  /** プリセットの保存キー (`gridPresetsKeyFrom`)。 */
  storageKey: string;
  /** `DataGrid` が公開する取得/適用の操作。 */
  handleRef: RefObject<GridViewPresetsHandle | null>;
}

/**
 * 結果グリッドのツールバーの「ビュー」メニュー (#1942)。現在のソート・フィルタ・列レイアウト・
 * マスク上書きを名前付きで保存し、一覧から丸ごと適用/上書き/削除する。自動永続化 (最新 1 状態) とは
 * 独立した任意のレイヤで、保存先は結果シェイプ単位の `noobdb.gridpresets.v1`。
 */
export function GridViewPresetsMenu({ storageKey, handleRef }: Props) {
  const t = useT();
  const toast = useToast();
  const [presets, setPresets] = useState<GridViewPreset[]>(() => readStoredGridPresets(storageKey));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [naming, setNaming] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // 別の結果シェイプへ切り替わったら読み直す (書き込みは操作時のみなので古い値で競合しない)。
  useEffect(() => {
    setPresets(readStoredGridPresets(storageKey));
  }, [storageKey]);

  const commit = useCallback(
    (next: GridViewPreset[]) => {
      setPresets(next);
      writeStoredGridPresets(storageKey, next);
    },
    [storageKey],
  );

  const save = (name: string) => {
    const snapshot = handleRef.current?.capture();
    if (!snapshot) return;
    const { presets: next, full } = upsertGridPreset(presets, { name, ...snapshot });
    if (full) {
      toast.info(t("gridPresetFull", { max: GRID_PRESET_MAX }));
      return;
    }
    commit(next);
    toast.success(t("gridPresetSaved", { name }));
  };

  const items: ContextMenuEntry[] = [];
  if (presets.length === 0) {
    items.push({ label: t("gridPresetEmpty"), disabled: true, onSelect: () => {} });
  } else {
    for (const p of presets) {
      items.push({
        label: p.name,
        title: t("gridPresetApplyTitle", { name: p.name }),
        onSelect: () => handleRef.current?.apply(p),
      });
    }
  }
  items.push({ separator: true });
  items.push({
    label: t("gridPresetSaveNew"),
    icon: "plus",
    disabled: presets.length >= GRID_PRESET_MAX,
    title: presets.length >= GRID_PRESET_MAX ? t("gridPresetFull", { max: GRID_PRESET_MAX }) : undefined,
    onSelect: () => setNaming(true),
  });
  if (presets.length > 0) {
    items.push({
      label: t("gridPresetOverwriteMenu"),
      items: presets.map((p) => ({
        label: p.name,
        onSelect: () => save(p.name),
      })),
    });
    items.push({
      label: t("gridPresetDeleteMenu"),
      items: presets.map((p) => ({
        label: p.name,
        danger: true,
        onSelect: () => {
          commit(removeGridPreset(presets, p.name));
          toast.info(t("gridPresetDeleted", { name: p.name }));
        },
      })),
    });
  }

  return (
    <>
      <Tooltip label={t("gridPresetButtonTitle")}>
        <Button
          ref={btnRef}
          size="sm"
          px="1.5"
          aria-label={t("gridPresetButton")}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          onClick={() => {
            // 他タブ/他ペインで更新されている可能性があるので、開くたびに読み直す。
            setPresets(readStoredGridPresets(storageKey));
            const r = btnRef.current?.getBoundingClientRect();
            if (r) setMenu({ x: r.left, y: r.bottom + 2 });
          }}
        >
          <Icon name="snippet" size={ICON_SIZES.md} />
        </Button>
      </Tooltip>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      <AnimatePresence>
        {naming && (
          <GridViewPresetNameModal
            existingNames={presets.map((p) => p.name)}
            onConfirm={(name) => {
              setNaming(false);
              save(name);
            }}
            onClose={() => setNaming(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
