import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";

import { api, listenPgListenStream } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Callout } from "./Callout";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { ErrorNote, FieldError, FieldLabel } from "./modalForm";
import {
  appendNotification,
  checkChannelName,
  formatReceivedAt,
  payloadPreview,
  pgListenReasonKey,
  prettyJsonPayload,
  supportsPgListen,
  PG_LISTEN_MAX_BUFFER,
  PG_LISTEN_MAX_CHANNELS,
  type BufferedNotification,
  type ChannelNameProblem,
} from "./pgListen";
import { Button, Heading, Input } from "./ui";

/**
 * PostgreSQL の LISTEN / NOTIFY リアルタイム監視タブ (#2019 / ボトムパネルの診断グループ)。
 *
 * 専用接続を 1 本張って選んだチャンネルを `LISTEN` し、届いた通知 (チャンネル / payload /
 * 送信 PID / 受信時刻) を新しい順に並べる。購読の追加・削除は監視中でも行え、停止・タブを閉じる・
 * 切断でバックエンドのリスナも一緒に終わる。読み取りのみで `read_only` 接続でも使える
 * (`NOTIFY` の送信機能は持たない)。MySQL / SQLite には pub/sub が無いので、理由コード
 * (`unsupported_driver`) つきで縮退表示する。
 *
 * 受信バッファは `PG_LISTEN_MAX_BUFFER` 件で、超えたら古い通知から捨てる。payload は
 * バックエンドが 2000 文字に切り詰めて届ける。
 */

const thCss: SystemStyleObject = {
  position: "sticky",
  top: 0,
  background: "var(--bg-muted)",
  borderBottom: "1px solid var(--border)",
  padding: "var(--space-1-5) var(--space-2-5)",
  textStyle: "overline",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
  textAlign: "left",
};
const tdCss: SystemStyleObject = {
  borderBottom: "1px solid var(--border-subtle, var(--border))",
  padding: "var(--space-1-25) var(--space-2-5)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  verticalAlign: "top",
};

type Status = "idle" | "connecting" | "listening";

let pgListenStreamSeq = 0;
/** 監視 1 回ごとの一意な stream id (通知の宛先とキャンセル・チャンネル操作の宛先)。 */
function makePgListenStreamId(): string {
  pgListenStreamSeq += 1;
  return `pglisten_${Date.now().toString(36)}_${pgListenStreamSeq.toString(36)}`;
}

const PROBLEM_KEY: Record<ChannelNameProblem | "duplicate" | "tooMany", I18nKey> = {
  empty: "pgListenErrEmpty",
  tooLong: "pgListenErrTooLong",
  nul: "pgListenErrNul",
  duplicate: "pgListenErrDuplicate",
  tooMany: "pgListenErrTooMany",
};

export function PgListenPanel({ sessionId, driver }: { sessionId: string; driver: string }) {
  const t = useT();
  const formId = useId();
  const supported = supportsPgListen(driver);

  const [channels, setChannels] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [items, setItems] = useState<BufferedNotification[]>([]);
  const [dropped, setDropped] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<"reconnected" | "closed" | null>(null);
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  const seqRef = useRef(0);
  const activeRef = useRef<{ streamId: string; unlisten: () => void } | null>(null);

  /** 監視を止めて Channel の購読を外す (バックエンドのリスナも `cancel_stream` で終わる)。 */
  const stopActive = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    active.unlisten();
    void api.cancelStream(active.streamId).catch(() => {});
  }, []);

  // アンマウント (タブを閉じる・切断・接続の切替) で監視を止め、リスナを残さない。
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId は「接続が変わった」トリガー。本体では読まないが、切替のたびに前の接続の監視を止める
  useEffect(() => stopActive, [stopActive, sessionId]);

  const start = useCallback(async () => {
    stopActive();
    const streamId = makePgListenStreamId();
    const slot = { streamId, unlisten: () => {} };
    activeRef.current = slot;
    const isActive = () => activeRef.current === slot;
    const settle = () => {
      if (!isActive()) return;
      activeRef.current = null;
      setStatus("idle");
      slot.unlisten();
    };
    setError(null);
    setNotice(null);
    setUnsupportedReason(null);
    setStatus("connecting");
    try {
      slot.unlisten = await listenPgListenStream(streamId, {
        onStarted: () => {
          if (isActive()) setStatus("listening");
        },
        onNotification: (n) => {
          if (!isActive()) return;
          seqRef.current += 1;
          const entry: BufferedNotification = { ...n, seq: seqRef.current };
          setItems((cur) => {
            const next = appendNotification(cur, entry);
            if (next.dropped > 0) setDropped((d) => d + next.dropped);
            return next.items;
          });
        },
        onReconnected: () => {
          if (isActive()) setNotice("reconnected");
        },
        onUnsupported: ({ reason }) => {
          if (!isActive()) return;
          setUnsupportedReason(reason);
          settle();
        },
        onError: ({ error: message }) => {
          if (!isActive()) return;
          setError(message);
          settle();
        },
        // 自分で止めたときは購読を外してあるので届かない。届くのは切断など外からの停止。
        onCancelled: () => {
          if (!isActive()) return;
          setNotice("closed");
          settle();
        },
      });
      if (!isActive()) {
        slot.unlisten();
        return;
      }
      await api.startPgListen({ sessionId, streamId, channels });
    } catch (e) {
      if (!isActive()) return;
      setError(String(e));
      settle();
    }
  }, [channels, sessionId, stopActive]);

  const stop = useCallback(() => {
    stopActive();
    setStatus("idle");
  }, [stopActive]);

  const addChannel = useCallback(async () => {
    const checked = checkChannelName(input);
    if (!checked.ok) {
      setInputError(t(PROBLEM_KEY[checked.problem]));
      return;
    }
    if (channels.includes(checked.name)) {
      setInputError(t(PROBLEM_KEY.duplicate));
      return;
    }
    if (channels.length >= PG_LISTEN_MAX_CHANNELS) {
      setInputError(t(PROBLEM_KEY.tooMany, { max: PG_LISTEN_MAX_CHANNELS }));
      return;
    }
    setInputError(null);
    const active = activeRef.current;
    if (active) {
      try {
        await api.pgListenAddChannel(active.streamId, checked.name);
      } catch (e) {
        setInputError(String(e));
        return;
      }
    }
    setChannels((cur) => (cur.includes(checked.name) ? cur : [...cur, checked.name]));
    setInput("");
  }, [channels, input, t]);

  const removeChannel = useCallback(async (name: string) => {
    setInputError(null);
    const active = activeRef.current;
    if (active) {
      try {
        await api.pgListenRemoveChannel(active.streamId, name);
      } catch (e) {
        setInputError(String(e));
        return;
      }
    }
    setChannels((cur) => cur.filter((c) => c !== name));
  }, []);

  const clear = () => {
    setItems([]);
    setDropped(0);
    setExpanded(null);
  };

  if (!supported) {
    // MySQL / SQLite には LISTEN / NOTIFY が無い。理由コードを添えて縮退する (#587 の流儀)。
    return (
      <Box flex="1" overflowY="auto" py="5" px="6" display="flex" flexDirection="column" gap="3.5">
        <Heading>{t("pgListenTitle")}</Heading>
        <Callout tone="warning" role="status" data-testid="pglisten-unsupported">
          {t("pgListenUnsupported", { reason: t(pgListenReasonKey("unsupported_driver")) })}
        </Callout>
      </Box>
    );
  }

  const running = status !== "idle";
  const ordered = [...items].reverse();

  return (
    <Box flex="1" overflowY="auto" py="3.5" px="4" display="flex" flexDirection="column" gap="3">
      <chakra.p margin={0} textStyle="body" color="app.textMuted">
        {t("pgListenDesc")}
      </chakra.p>

      <chakra.form
        onSubmit={(e) => {
          e.preventDefault();
          void addChannel();
        }}
        display="flex"
        alignItems="flex-end"
        gap="3"
        flexWrap="wrap"
      >
        <Flex direction="column" gap="1">
          <FieldLabel htmlFor={`${formId}-channel`}>{t("pgListenChannelLabel")}</FieldLabel>
          <Input
            id={`${formId}-channel`}
            width="220px"
            value={input}
            placeholder={t("pgListenChannelPlaceholder")}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            aria-invalid={inputError ? true : undefined}
            data-testid="pglisten-channel-input"
          />
        </Flex>
        <Button type="submit" disabled={status === "connecting"} data-testid="pglisten-add">
          <Icon name="plus" size={ICON_SIZES.sm} />
          <chakra.span marginLeft="1.5">{t("pgListenAdd")}</chakra.span>
        </Button>
        {running ? (
          <Button type="button" variant="secondary" onClick={stop} data-testid="pglisten-stop">
            <Icon name="close" size={ICON_SIZES.sm} />
            <chakra.span marginLeft="1.5">{t("pgListenStop")}</chakra.span>
          </Button>
        ) : (
          <Button
            type="button"
            variant="primary"
            onClick={() => void start()}
            disabled={channels.length === 0}
            data-testid="pglisten-start"
          >
            <Icon name="play" size={ICON_SIZES.sm} />
            <chakra.span marginLeft="1.5">{t("pgListenStart")}</chakra.span>
          </Button>
        )}
        <Button type="button" onClick={clear} disabled={items.length === 0} data-testid="pglisten-clear">
          {t("pgListenClear")}
        </Button>
      </chakra.form>

      {inputError && <FieldError display="block">{inputError}</FieldError>}

      <Flex align="center" gap="2" wrap="wrap" data-testid="pglisten-channels">
        {channels.length === 0 ? (
          <chakra.span textStyle="caption">{t("pgListenNoChannels")}</chakra.span>
        ) : (
          channels.map((c) => (
            <Flex
              key={c}
              align="center"
              gap="1"
              paddingY="0.5"
              paddingLeft="2"
              paddingRight="1"
              borderWidth="1px"
              borderColor="app.border"
              borderRadius="md"
              fontFamily="var(--font-mono)"
              fontSize="sm"
              color="app.text"
            >
              <span>{c}</span>
              <chakra.button
                type="button"
                aria-label={t("pgListenRemoveChannel", { channel: c })}
                disabled={status === "connecting"}
                onClick={() => void removeChannel(c)}
                display="inline-flex"
                color="app.textMuted"
                cursor="pointer"
                background="transparent"
                border="none"
                padding="0.5"
              >
                <Icon name="close" size={ICON_SIZES.sm} />
              </chakra.button>
            </Flex>
          ))
        )}
      </Flex>

      <chakra.div textStyle="caption" aria-live="polite" data-testid="pglisten-status">
        {status === "connecting"
          ? t("pgListenStatusConnecting")
          : status === "listening"
            ? t("pgListenStatusListening", { count: channels.length })
            : t("pgListenStatusIdle")}
        {" · "}
        {t("pgListenCount", { count: items.length })}
      </chakra.div>

      {unsupportedReason && (
        <Callout tone="warning" role="status" data-testid="pglisten-unsupported">
          {t("pgListenUnsupported", { reason: t(pgListenReasonKey(unsupportedReason)) })}
        </Callout>
      )}
      {error && <ErrorNote>{t("pgListenError", { error })}</ErrorNote>}
      {notice === "reconnected" && (
        <Callout tone="warning" role="status" data-testid="pglisten-reconnected">
          {t("pgListenReconnected")}
        </Callout>
      )}
      {notice === "closed" && (
        <Callout tone="info" role="status" data-testid="pglisten-closed">
          {t("pgListenClosed")}
        </Callout>
      )}
      {dropped > 0 && (
        <Callout tone="info" role="status" data-testid="pglisten-dropped">
          {t("pgListenDropped", { count: dropped, max: PG_LISTEN_MAX_BUFFER })}
        </Callout>
      )}

      {items.length === 0 ? (
        <EmptyState compact icon="bell" title={t("pgListenEmpty")} />
      ) : (
        <Box overflowX="auto">
          <chakra.table width="100%" borderCollapse="collapse">
            <thead>
              <tr>
                <chakra.th css={thCss}>{t("pgListenColTime")}</chakra.th>
                <chakra.th css={thCss}>{t("pgListenColChannel")}</chakra.th>
                <chakra.th css={thCss}>{t("pgListenColPid")}</chakra.th>
                <chakra.th css={thCss}>{t("pgListenColPayload")}</chakra.th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((n) => {
                const open = expanded === n.seq;
                const pretty = open ? prettyJsonPayload(n.payload) : null;
                return (
                  <tr key={n.seq} data-testid="pglisten-row">
                    <chakra.td css={tdCss} whiteSpace="nowrap">
                      {formatReceivedAt(n.receivedAtMs)}
                    </chakra.td>
                    <chakra.td css={tdCss} whiteSpace="nowrap">
                      {n.channel}
                    </chakra.td>
                    <chakra.td css={tdCss} whiteSpace="nowrap">
                      {n.pid}
                    </chakra.td>
                    <chakra.td css={tdCss}>
                      <chakra.button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : n.seq)}
                        textAlign="left"
                        background="transparent"
                        border="none"
                        padding="0"
                        cursor="pointer"
                        color="inherit"
                        font="inherit"
                        wordBreak="break-all"
                        whiteSpace={open ? "pre-wrap" : "normal"}
                      >
                        {open ? (pretty ?? n.payload) : payloadPreview(n.payload)}
                      </chakra.button>
                      {n.payloadTruncated && (
                        <chakra.span marginLeft="2" textStyle="caption">
                          {t("pgListenTruncated")}
                        </chakra.span>
                      )}
                    </chakra.td>
                  </tr>
                );
              })}
            </tbody>
          </chakra.table>
        </Box>
      )}
    </Box>
  );
}
