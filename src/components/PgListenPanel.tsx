import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, type SystemStyleObject } from "@chakra-ui/react";
import { useReducedMotion } from "motion/react";

import { api, listenPgListenStream } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Callout } from "./Callout";
import { EmptyState } from "./EmptyState";
import { Icon, ICON_SIZES } from "./Icon";
import { LiveCell, LiveRowsPresence, LiveTr } from "./LiveRows";
import { ErrorNote, FieldError, FieldLabel } from "./modalForm";
import {
  appendNotification,
  checkChannelName,
  countByChannel,
  formatReceivedAt,
  payloadPreview,
  pendingCount,
  pgListenReasonKey,
  prettyJsonPayload,
  supportsPgListen,
  visibleNotifications,
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
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  verticalAlign: "top",
};

/** 一時停止から再開するとき、これを超える件数が溜まっていたら入場フラッシュを省く。 */
const FLASH_BATCH_MAX = 30;

/** `LiveCell` の内側 (パディング)。`<td>` 側の境界線・フォントとは別に持つ。 */
const cellInnerCss: SystemStyleObject = { padding: "var(--space-1-25) var(--space-2-5)" };

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
  /** 表示一時停止の凍結点 (停止した時点の最新 seq)。null なら追従表示。受信は止めない (#2093)。 */
  const [pause, setPause] = useState<{ at: number; snapshot: BufferedNotification[] } | null>(null);
  const pausedAt = pause?.at ?? null;
  /** 一時停止が payload 展開による自動のものか (折りたたむと自動で解除する)。 */
  const [autoPaused, setAutoPaused] = useState(false);
  /** 絞り込み中のチャンネル。null なら全チャンネル。 */
  const [filter, setFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<"reconnected" | "closed" | null>(null);
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  const seqRef = useRef(0);
  /** 受信バッファの実体 (`items` はこれの表示用コピー)。 */
  const bufferRef = useRef<BufferedNotification[]>([]);
  /** 画面に出し終えた最新の seq (これより新しい行だけ入場時にフラッシュさせる)。 */
  const shownSeqRef = useRef(0);
  /** 大量の新着を一度に反映するとき、この seq 以下の行はフラッシュさせない。 */
  const noFlashUpToRef = useRef(0);
  const activeRef = useRef<{ streamId: string; unlisten: () => void } | null>(null);

  // 描画後に「ここまで見せた」を更新する (次に入場する行だけをフラッシュさせるため)。
  useEffect(() => {
    shownSeqRef.current = pausedAt ?? items[items.length - 1]?.seq ?? 0;
  });

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
    // 新しい監視は「すべて」・追従表示から始める (古いスナップショットや絞り込みを持ち越さない)。
    setFilter(null);
    setPause(null);
    setAutoPaused(false);
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
          // バッファは ref が正 (updater を使わないので StrictMode でも二重に数えない)。
          const next = appendNotification(bufferRef.current, entry);
          bufferRef.current = next.items;
          setItems(next.items);
          if (next.dropped > 0) setDropped((d) => d + next.dropped);
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
      // 開始要求の待機中に停止・パネルを閉じた場合、stopActive の取り消しは登録前に
      // 届いて空振りしうる。登録が済んだ今もう一度取り消し、接続を残さない。
      if (!isActive()) void api.cancelStream(streamId).catch(() => {});
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
    setFilter((f) => (f === name ? null : f));
  }, []);

  const clear = () => {
    bufferRef.current = [];
    setItems([]);
    setDropped(0);
    setExpanded(null);
    setPause(null);
    setAutoPaused(false);
  };

  /** 表示を止める。停止時点の一覧をスナップショットで握り、バッファが溢れても見ている行を消さない。 */
  const freeze = () => setPause({ at: seqRef.current, snapshot: bufferRef.current });
  const resume = useCallback(() => {
    // 溜まった件数が多いときは、入場フラッシュを省く (画面全体が一斉に光るのを避ける)。
    if (
      bufferRef.current.length > 0 &&
      seqRef.current - (latest.current.pause?.at ?? seqRef.current) > FLASH_BATCH_MAX
    ) {
      noFlashUpToRef.current = seqRef.current;
    }
    setPause(null);
    setAutoPaused(false);
  }, []);
  const togglePause = () => {
    if (pause === null) freeze();
    else resume();
    setAutoPaused(false);
  };
  const latest = useRef({ expanded, autoPaused, pause });
  latest.current = { expanded, autoPaused, pause };
  const toggleExpanded = useCallback(
    (seq: number) => {
      const cur = latest.current;
      if (cur.expanded === seq) {
        setExpanded(null);
        if (cur.autoPaused) resume();
        return;
      }
      setExpanded(seq);
      // 読んでいる行がずれないよう、展開中は自動で表示を止める (手動で止めていればそのまま)。
      if (cur.pause === null) {
        setPause({ at: seqRef.current, snapshot: bufferRef.current });
        setAutoPaused(true);
      }
    },
    [resume],
  );
  /** 絞り込みを変える。自動停止中に展開行が隠れるなら、折りたたんで自動停止も解く。 */
  const selectFilter = (next: string | null) => {
    setFilter(next);
    if (expanded === null || next === null) return;
    const row = (pause?.snapshot ?? items).find((n) => n.seq === expanded);
    if (row && row.channel !== next) {
      setExpanded(null);
      if (autoPaused) resume();
    }
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
  const statusLabel =
    status === "connecting"
      ? t("pgListenStatusConnecting")
      : status === "listening"
        ? t("pgListenStatusListening", { count: channels.length })
        : t("pgListenStatusIdle");
  const shown = visibleNotifications(items, pause?.snapshot ?? null);
  const counts = countByChannel(shown);
  const activeFilter = filter !== null && channels.includes(filter) ? filter : null;
  const pending = pendingCount(items, pausedAt, activeFilter);
  const ordered = (activeFilter === null ? shown : shown.filter((n) => n.channel === activeFilter)).reverse();

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
          <>
            <ChannelChip
              label={t("pgListenFilterAll")}
              count={shown.length}
              pressed={activeFilter === null}
              onClick={() => selectFilter(null)}
              testId="pglisten-filter-all"
            />
            {channels.map((c) => (
              <Flex
                key={c}
                align="center"
                gap="1"
                paddingRight="1"
                borderWidth="1px"
                borderColor={activeFilter === c ? "app.accent" : "app.border"}
                borderRadius="md"
                fontFamily="var(--font-mono)"
                fontSize="sm"
                color="app.text"
              >
                <ChannelChip
                  label={c}
                  count={counts.get(c) ?? 0}
                  pressed={activeFilter === c}
                  onClick={() => selectFilter(activeFilter === c ? null : c)}
                  testId={`pglisten-filter-${c}`}
                  bare
                />
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
            ))}
          </>
        )}
      </Flex>

      <Flex align="center" gap="2" wrap="wrap">
        <StatusPill status={status} label={statusLabel} />
        <chakra.span textStyle="caption" data-testid="pglisten-count">
          {t("pgListenCount", { count: items.length })}
        </chakra.span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={togglePause}
          data-testid="pglisten-pause"
        >
          {pausedAt !== null ? t("pgListenResume") : t("pgListenPause")}
        </Button>
        {pausedAt !== null && (
          <chakra.span textStyle="caption" data-testid="pglisten-paused-note">
            {autoPaused ? t("pgListenPausedAuto") : t("pgListenPausedManual")}
          </chakra.span>
        )}
        {pending > 0 && (
          <Button type="button" size="sm" variant="primary" onClick={resume} data-testid="pglisten-pending">
            {t("pgListenPending", { count: pending })}
          </Button>
        )}
      </Flex>

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
              <LiveRowsPresence>
                {ordered.map((n) => (
                  <NotificationRow
                    key={n.seq}
                    n={n}
                    open={expanded === n.seq}
                    isNew={n.seq > shownSeqRef.current && n.seq > noFlashUpToRef.current}
                    onToggle={toggleExpanded}
                  />
                ))}
              </LiveRowsPresence>
            </tbody>
          </chakra.table>
        </Box>
      )}
    </Box>
  );
}

/** チャンネルのフィルタ用チップ (件数つき)。`bare` は外枠を持たない (購読解除ボタンと枠を共有する)。 */
function ChannelChip({
  label,
  count,
  pressed,
  onClick,
  testId,
  bare = false,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
  testId: string;
  bare?: boolean;
}) {
  const t = useT();
  return (
    <chakra.button
      type="button"
      aria-pressed={pressed}
      aria-label={t("pgListenChipAria", { channel: label, count })}
      onClick={onClick}
      data-testid={testId}
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      paddingY="0.5"
      paddingX="2"
      borderRadius="md"
      borderWidth={bare ? 0 : "1px"}
      borderColor={pressed ? "app.accent" : "app.border"}
      bg={pressed ? "var(--accent-subtle)" : "transparent"}
      color="app.text"
      fontFamily="inherit"
      fontSize="inherit"
      cursor="pointer"
    >
      <span>{label}</span>
      <chakra.span textStyle="numeric" color="app.textMuted">
        {count}
      </chakra.span>
    </chakra.button>
  );
}

/** 監視状態のピル。listening 中だけ点を脈動させる (reduced-motion では止める)。 */
function StatusPill({ status, label }: { status: Status; label: string }) {
  const reduced = useReducedMotion();
  const animated = (status === "listening" || status === "connecting") && !reduced;
  const dot =
    status === "listening"
      ? "var(--status-connected)"
      : status === "connecting"
        ? "var(--status-connecting)"
        : "var(--status-idle)";
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      gap="1.5"
      paddingY="0.5"
      paddingX="2"
      borderRadius="pill"
      borderWidth="1px"
      borderColor="app.border"
      textStyle="caption"
      color="app.text"
      data-testid="pglisten-status"
      aria-live="polite"
      data-status={status}
    >
      <chakra.span
        aria-hidden="true"
        display="inline-block"
        width="2"
        height="2"
        borderRadius="pill"
        flexShrink={0}
        data-pulsing={animated ? "true" : "false"}
        style={{
          background: dot,
          animation: animated ? "pulse 1.2s ease-in-out infinite" : undefined,
        }}
      />
      {label}
    </chakra.span>
  );
}

/**
 * 通知 1 行。入場時のフラッシュは「マウント時に新着だったか」を一度だけ決めて固定する
 * (再描画で token が変わってフラッシュが途切れたり、フィルタ切替で再生し直したりしない)。
 */
const NotificationRow = memo(function NotificationRow({
  n,
  open,
  isNew,
  onToggle,
}: {
  n: BufferedNotification;
  open: boolean;
  isNew: boolean;
  onToggle: (seq: number) => void;
}) {
  const t = useT();
  const [flash] = useState<number | null>(isNew ? n.seq : null);
  const pretty = useMemo(() => (open ? prettyJsonPayload(n.payload) : null), [open, n.payload]);
  return (
    <LiveTr testId="pglisten-row">
      <LiveCell
        css={tdCss}
        innerCss={{ ...cellInnerCss, whiteSpace: "nowrap" }}
        flash={flash}
        collapse={false}
      >
        {formatReceivedAt(n.receivedAtMs)}
      </LiveCell>
      <LiveCell
        css={tdCss}
        innerCss={{ ...cellInnerCss, whiteSpace: "nowrap" }}
        flash={flash}
        collapse={false}
      >
        {n.channel}
      </LiveCell>
      <LiveCell
        css={tdCss}
        innerCss={{ ...cellInnerCss, whiteSpace: "nowrap" }}
        flash={flash}
        collapse={false}
      >
        {n.pid}
      </LiveCell>
      <LiveCell css={tdCss} innerCss={cellInnerCss} flash={flash} collapse={false}>
        <chakra.button
          type="button"
          aria-expanded={open}
          onClick={() => onToggle(n.seq)}
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
      </LiveCell>
    </LiveTr>
  );
});
