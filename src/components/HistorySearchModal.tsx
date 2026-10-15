import { Box, chakra } from "@chakra-ui/react";
import { useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { singleLine } from "./commandPaletteSearch";
import { Modal } from "./Modal";
import { isImeComposing } from "./modalKeys";
import { filterHistory } from "./queryHistoryNav";

/** 一度に並べる候補の最大数。履歴は最大 100 件なので実質すべて出せる。 */
const MAX_ROWS = 50;

interface Props {
  /** 直近の実行クエリ (最新が先頭)。 */
  history: string[];
  /** 選んだ SQL をエディタへ戻す (実行はしない)。 */
  onPick: (sql: string) => void;
  onClose: () => void;
}

/**
 * クエリ履歴のインクリメンタル検索 (#1627、Ctrl+R 相当)。入力に合わせて部分一致で絞り、
 * ↑/↓ で選んで Enter でエディタへ戻す。エディタの ↑/↓ ナビ (下書き退避つき) とは独立で、
 * 戻した後の編集内容はエディタの undo で元へ戻せる。
 */
export function HistorySearchModal({ history, onPick, onClose }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => filterHistory(history, query).slice(0, MAX_ROWS), [history, query]);
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));

  const pick = (sql: string | undefined) => {
    if (sql === undefined) return;
    onPick(sql);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      if (isImeComposing(e)) return;
      e.preventDefault();
      pick(rows[activeIndex]);
    }
  };

  return (
    <Modal
      // no-submit: 検索 UI。Enter が候補の決定を担う
      open
      onClose={onClose}
      width="620px"
      initialFocusEl={() => inputRef.current}
    >
      <chakra.input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        placeholder={t("queryHistorySearchPlaceholder")}
        aria-label={t("queryHistorySearchPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        w="100%"
        px="3.5"
        py="3.5"
        bg="app.surface"
        border="none"
        borderBottomWidth="1px"
        borderBottomColor="app.border"
        outline="none"
        color="app.text"
        fontSize="md"
      />
      <Box
        role="listbox"
        aria-label={t("queryHistorySearchListAria")}
        maxH="min(420px, 60vh)"
        overflowY="auto"
        py="1.5"
      >
        {rows.length === 0 ? (
          <Box px="4" py="5" textAlign="center" color="app.textMuted" fontSize="sm">
            {history.length === 0 ? t("queryHistorySearchEmpty") : t("queryHistorySearchNoMatch")}
          </Box>
        ) : (
          rows.map((sql, i) => (
            <chakra.button
              key={`${i}:${sql}`}
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              onClick={() => pick(sql)}
              onMouseMove={() => setActive(i)}
              display="block"
              w="100%"
              px="4"
              py="2"
              textAlign="left"
              fontSize="sm"
              fontFamily="mono"
              bg={i === activeIndex ? "app.active" : "transparent"}
              color="app.text"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
              cursor="pointer"
            >
              {singleLine(sql)}
            </chakra.button>
          ))
        )}
      </Box>
    </Modal>
  );
}
