import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { copyToClipboard } from "./clipboard";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { Icon, ICON_SIZES } from "./Icon";
import { TEXT_FORMAT_EXT, type TextFormatId } from "./tabularText";
import { useToast } from "./Toast";
import { Button } from "./ui";

/**
 * 表示中の内容を CSV / TSV / Markdown / JSON のテキストとして「コピー」または「ファイルに保存」
 * する共通ボタン (#1539)。ファイル書き出しは既存の Rust コマンド `write_text_file` 経由
 * (フロントから fs を直接叩かない)、コピーは `copyToClipboard`。整形は呼び出し側が純関数で
 * 行い、`build` はクリック時にだけ評価する (大きな表を毎描画で文字列化しない)。
 */
export interface TextExportFormat {
  id: TextFormatId;
  /** メニューに出す形式名 (例: "CSV")。 */
  label: string;
  build: () => string;
}

interface Props {
  formats: readonly TextExportFormat[];
  /** 保存ファイル名のベース (拡張子なし)。 */
  filenameBase: string;
  disabled?: boolean;
  /** ボタンのラベル。省略時は「書き出し」。 */
  label?: string;
  /** 保存先ダイアログのタイトル。 */
  saveTitle?: string;
}

export function TextExportButton({ formats, filenameBase, disabled, label, saveTitle }: Props) {
  const t = useT();
  const toast = useToast();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const text = label ?? t("textExportButton");

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.bottom + 2 });
  };

  const handleCopy = async (f: TextExportFormat) => {
    const ok = await copyToClipboard(f.build());
    if (ok) toast.success(t("textExportCopied", { format: f.label }));
    else toast.error(t("textExportCopyFailed"));
  };

  const handleSave = async (f: TextExportFormat) => {
    setBusy(true);
    try {
      const ext = TEXT_FORMAT_EXT[f.id];
      let defaultPath = `${filenameBase}.${ext}`;
      try {
        defaultPath = await join(await downloadDir(), defaultPath);
      } catch {
        // ダウンロードフォルダが解決できない環境ではファイル名のみで開く。
      }
      const picked = await save({
        defaultPath,
        title: saveTitle ?? text,
        filters: [{ name: f.label, extensions: [ext] }],
      });
      if (typeof picked !== "string" || !picked) return;
      await api.writeTextFile(picked, f.build());
      toast.success(t("textExportSaved", { path: picked }));
    } catch (e) {
      toast.error(t("textExportSaveError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const items: ContextMenuEntry[] = [
    ...formats.map((f) => ({
      label: t("textExportCopyAs", { format: f.label }),
      onSelect: () => void handleCopy(f),
    })),
    { separator: true },
    ...formats.map((f) => ({
      label: t("textExportSaveAs", { format: f.label }),
      onSelect: () => void handleSave(f),
    })),
  ];

  return (
    <>
      <Button
        ref={btnRef}
        type="button"
        variant="secondary"
        size="sm"
        onClick={openMenu}
        disabled={busy || disabled}
        aria-haspopup="menu"
      >
        <Icon name="download" size={ICON_SIZES.md} />
        {text}
      </Button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}
