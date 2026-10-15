import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { useT } from "../i18n";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";
import { Icon, ICON_SIZES } from "./Icon";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import {
  blobToBytes,
  copyPngToClipboard,
  EXPORT_BACKGROUNDS,
  EXPORT_SCALES,
  resolvePngExportOptions,
  saveImageBytes,
  type ExportBackground,
  type ExportScale,
  type PngExportOptions,
} from "./imageExport";
import { usePersistedImageExportPrefs } from "./imageExportPrefs";

/**
 * チャート/ER 図の画像エクスポート用ボタン (#643)。クリックでメニュー
 * (PNG 保存 / SVG 保存 / クリップボードへコピー) を開く。実際の画像化は呼び出し側が
 * `makePng` / `makeSvg` で供給する (ChartView は SVG 要素、ERDiagramView は全景の
 * ビューポートと、捕捉対象が異なるため)。保存は `dialog:allow-save` のダイアログで
 * パスを得てバックエンドの `write_binary_file` で書き出す。
 */
interface Props {
  /**
   * PNG の Blob を生成する。メニューで選んだ倍率と背景色が `opts` で渡る (#1628) ので、
   * 呼び出し側は `elementToPngBlob` へそのまま転送する。
   */
  makePng: (opts: PngExportOptions) => Promise<Blob>;
  /** SVG のバイト列を生成する。 */
  makeSvg: () => Promise<Uint8Array>;
  /** 保存ファイル名のベース (拡張子なし)。 */
  filenameBase: string;
  /** ボタンサイズ。既定 "sm"。 */
  size?: "sm" | "md";
  /** アイコンのみ表示 (ラベルを隠す)。 */
  iconOnly?: boolean;
  /** 書き出す対象がまだ無いとき (チャート未描画など) に無効化する。 */
  disabled?: boolean;
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

export function ImageExportButton({
  makePng,
  makeSvg,
  filenameBase,
  size = "sm",
  iconOnly,
  disabled,
}: Props) {
  const t = useT();
  const toast = useToast();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // 倍率と背景色 (#1628)。選んだ値は次回以降も使う。
  const [prefs, setPrefs] = usePersistedImageExportPrefs();
  const pngOptions = () => resolvePngExportOptions(prefs.scale, prefs.background);

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.bottom + 2 });
  };

  const handleSave = async (ext: "png" | "svg") => {
    setBusy(true);
    try {
      const path = await pickPath(filenameBase, ext);
      if (!path) return;
      const bytes = ext === "png" ? await blobToBytes(await makePng(pngOptions())) : await makeSvg();
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
      const ok = await copyPngToClipboard(await makePng(pngOptions()));
      if (ok) toast.success(t("imageExportCopied"));
      else toast.error(t("imageExportCopyFailed"));
    } catch (e) {
      toast.error(t("imageExportError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  // 現在の選択には先頭に ✓ を付ける (メニューにチェック表示が無いため)。
  const mark = (selected: boolean, label: string) => `${selected ? "✓ " : "   "}${label}`;
  const items: ContextMenuEntry[] = [
    { label: t("imageExportPng"), onSelect: () => void handleSave("png") },
    { label: t("imageExportSvg"), onSelect: () => void handleSave("svg") },
    { separator: true },
    { label: t("imageExportCopy"), onSelect: () => void handleCopy() },
    { separator: true },
    {
      label: t("imageExportScale", { scale: prefs.scale }),
      title: t("imageExportScaleTitle"),
      items: EXPORT_SCALES.map((scale: ExportScale) => ({
        label: mark(prefs.scale === scale, `${scale}x`),
        onSelect: () => setPrefs({ ...prefs, scale }),
      })),
    },
    {
      label: t("imageExportBackground", { background: t(`imageExportBg_${prefs.background}`) }),
      title: t("imageExportBackgroundTitle"),
      items: EXPORT_BACKGROUNDS.map((background: ExportBackground) => ({
        label: mark(prefs.background === background, t(`imageExportBg_${background}`)),
        onSelect: () => setPrefs({ ...prefs, background }),
        ...(background === "white" ? { title: t("imageExportBgWhiteHint") } : {}),
      })),
    },
  ];

  return (
    <>
      <Tooltip label={t("imageExportButton")} focusableWrapper={busy}>
        <Button
          ref={btnRef}
          type="button"
          variant="secondary"
          size={size}
          onClick={openMenu}
          disabled={busy || disabled}
          aria-label={t("imageExportButton")}
        >
          <Icon name="download" size={ICON_SIZES.md} />
          {!iconOnly && <span style={{ marginInlineStart: 6 }}>{t("imageExportButton")}</span>}
        </Button>
      </Tooltip>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}
