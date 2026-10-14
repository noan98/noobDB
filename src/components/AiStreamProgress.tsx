import { useEffect, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { partialJsonPreview } from "../ai/partialJson";
import type { UseAiStream } from "../ai/useAiStream";
import { useT } from "../i18n";
import { Spinner } from "./Spinner";

export interface AiStreamProgressProps {
  /** `useAiStream` の戻り値 (受信済み本文と開始時刻だけを使う)。 */
  stream: Pick<UseAiStream, "text"> & Partial<Pick<UseAiStream, "retrying" | "startedAt">>;
  /**
   * 構造化出力 (JSON) のとき、途中経過として見せる文章フィールドのキー (`explanation` など)。
   * 省略すると本文を「プレーンテキスト」としてそのまま見せる。JSON なのに指定しない画面は
   * 文字数だけ出す (`previewText={false}`)。
   */
  fields?: readonly string[];
  /** false なら本文は見せず、受信中の表示と経過秒数・文字数だけにする。 */
  previewText?: boolean;
  /** 応答開始前の文言。省略すると共通の「待っています」。 */
  waitingLabel?: string;
}

/**
 * AI 応答の受信中に出す共通の途中経過表示 (#1470): 「受信中」+ 経過秒数 + 文字数と、
 * 届いている文章 (構造化出力は `fields` の文字列フィールドだけ) を少しずつ見せる。
 * 中止ボタンなどは呼び出し側が横に並べる。
 */
/** 開始時刻からの経過秒数。毎秒の再描画をこの表示の中に閉じ込める (呼び出し側の画面は再描画されない)。 */
function useElapsedSec(startedAt: number | null | undefined): number {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (startedAt == null) {
      setSec(0);
      return;
    }
    const tick = () => setSec(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return sec;
}

export function AiStreamProgress({ stream, fields, previewText = true, waitingLabel }: AiStreamProgressProps) {
  const t = useT();
  const { text, retrying, startedAt } = stream;
  const elapsedSec = useElapsedSec(startedAt);
  const preview = !previewText ? "" : fields ? partialJsonPreview(text, fields) : text;
  return (
    <Flex direction="column" gap="1" data-testid="ai-stream-progress" minW="0">
      <Flex align="center" gap="2" wrap="wrap" color="app.textMuted" textStyle="caption">
        <Spinner size={12} />
        <chakra.span role="status">
          {retrying
            ? t("aiStreamRetrying", {
                attempt: retrying.attempt,
                max: retrying.maxAttempts,
                sec: Math.ceil(retrying.delayMs / 1000),
              })
            : text.length > 0
              ? t("aiStreamReceiving")
              : (waitingLabel ?? t("aiStreamWaiting"))}
        </chakra.span>
        {/* 毎秒変わる値は読み上げ領域 (role="status") の外に置く。 */}
        <chakra.span data-testid="ai-stream-elapsed">{t("aiStreamElapsed", { sec: elapsedSec })}</chakra.span>
        {text.length > 0 && <chakra.span>{t("aiStreamChars", { count: text.length })}</chakra.span>}
      </Flex>
      {preview.length > 0 && (
        <chakra.div
          whiteSpace="pre-wrap"
          color="app.text"
          maxH="160px"
          overflow="auto"
          aria-live="off"
          data-testid="ai-stream-preview"
        >
          {preview}
        </chakra.div>
      )}
    </Flex>
  );
}
