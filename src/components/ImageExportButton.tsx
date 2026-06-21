import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { useT } from "../i18n";
import { useToast } from "./Toast";
import { Button } from "./ui";
import { Icon } from "./Icon";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import {
  blobToBytes,
  copyPngToClipboard,
  saveImageBytes,
} from "./imageExport";

/**
 * チャート/ER 図の画像エクスポート用ボタン (#643)。クリックでメニュー
 * (PNG 保存 / SVG 保存 / クリップボードへコピー) を開く。実際の画像化は呼び出し側が
 * `makePng` / `makeSvg` で供給する (ChartView は SVG 要素、ERDiagramView は全景の
 * ビューポートと、捕捉対象が異なるため)。保存は `dialog:allow-save` のダイアログで
 * パスを得てバックエンドの `write_binary_file` で書き出す。
 */
interface Props {
  /** PNG の Blob を生成する (背景・ピクセル比は呼び出し側で指定)。 */
  makePng: () => Promise<Blob>;
  /** SVG のバイト列を生成する。 */
  makeSvg: () => Promise<Uint8Array>;
  /** 保存ファイル名のベース (拡張子なし)。 */
  filenameBase: string;
  /** ボタンサイズ。既定 "sm"。 */
  size?: "sm" | "md";
  /** アイコンのみ表示 (ラベルを隠す)。 */
  iconOnly?: boolean;
}

async function pickPath(base: string, ext: "png" | "svg"): Promise<string | null> {
  let defaultPath = `${base}.${ext}`;
  try {
    const dir = await downloadDir();
    defaultPath = await join(dir, `${base}.${ext}`);
  } catch {
    // ダウンロードフォルダが解決できない環境ではファイル名のみで開く。
  }
  const selected = await save({
    defaultPath,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return typeof selected === "string" && selected ? selected : null;
}

export function ImageExportButton({ makePng, makeSvg, filenameBase, size = "sm", iconOnly }: Props) {
  const t = useT();
  const toast = useToast();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.bottom + 2 });
  };

  const handleSave = async (ext: "png" | "svg") => {
    setBusy(true);
    try {
      const path = await pickPath(filenameBase, ext);
      if (!path) return;
      const bytes = ext === "png" ? await blobToBytes(await makePng()) : await makeSvg();
      await saveImageBytes(path, bytes);
      toast.success(t("imageExportSaved", { path }));
    } catch (e) {
      toast.error(t("imageExportError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    setBusy(true);
    try {
      const ok = await copyPngToClipboard(await makePng());
      if (ok) toast.success(t("imageExportCopied"));
      else toast.error(t("imageExportCopyFailed"));
    } catch (e) {
      toast.error(t("imageExportError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const items: ContextMenuEntry[] = [
    { label: t("imageExportPng"), onSelect: () => void handleSave("png") },
    { label: t("imageExportSvg"), onSelect: () => void handleSave("svg") },
    { separator: true },
    { label: t("imageExportCopy"), onSelect: () => void handleCopy() },
  ];

  return (
    <>
      <Button
        ref={btnRef}
        type="button"
        variant="secondary"
        size={size}
        onClick={openMenu}
        disabled={busy}
        title={t("imageExportButton")}
        aria-label={t("imageExportButton")}
      >
        <Icon name="download" size={14} />
        {!iconOnly && <span style={{ marginInlineStart: 6 }}>{t("imageExportButton")}</span>}
      </Button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </>
  );
}
