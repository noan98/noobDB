import { useRef, useState } from "react";
import { useT } from "../i18n";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { Tooltip } from "./Tooltip";
import { Button } from "./ui";

interface Props {
  /** 現在の SAVEPOINT スタック (古い順)。 */
  stack: readonly string[];
  onCreate: () => void;
  onRollbackTo: (name: string) => void;
  onRelease: (name: string) => void;
}

/**
 * 明示トランザクションの SAVEPOINT 操作 (#1418)。ボタンから、新規作成と
 * 各 SAVEPOINT への「ロールバック / 解放」を選ぶメニューを開く。
 */
export function SavepointControl({ stack, onCreate, onRollbackTo, onRelease }: Props) {
  const t = useT();
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setAnchor({ x: r.left, y: r.bottom });
  };

  const items: ContextMenuEntry[] = [
    { label: t("savepointCreate"), onSelect: onCreate },
    ...(stack.length > 0 ? [{ separator: true } as const] : []),
    // 新しいものを上に出す。
    ...[...stack].reverse().map(
      (name): ContextMenuEntry => ({
        label: name,
        items: [
          { label: t("savepointRollbackTo"), onSelect: () => onRollbackTo(name), danger: true },
          { label: t("savepointRelease"), onSelect: () => onRelease(name) },
        ],
      }),
    ),
  ];

  return (
    <>
      <Tooltip label={t("savepointHelp")}>
        <Button ref={ref} variant="secondary" size="sm" onClick={open}>
          {stack.length > 0 ? t("savepointButtonN", { count: stack.length }) : t("savepointButton")}
        </Button>
      </Tooltip>
      {anchor && <ContextMenu x={anchor.x} y={anchor.y} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}
