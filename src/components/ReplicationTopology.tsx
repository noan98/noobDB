import { Box, chakra, Flex } from "@chakra-ui/react";
import { useEffect, useState } from "react";

import type { DriverKind } from "../api/tauri";
import { useT } from "../i18n";
import { driverColor, driverIconName } from "../profileIdentity";
import { semanticColorToken, semanticColorVar } from "../semanticColors";
import { Icon, ICON_SIZES } from "./Icon";
import {
  formatLagSecs,
  layoutTopology,
  type KeyedLink,
  type TopologyLagLevel,
  type TopologyPeer,
} from "./replication";

/**
 * レプリケーションのトポロジー図 (#2215)。自ノードを中心に、上流 → 自ノード → 下流を矢印で結ぶ。
 * 矢印の色と太さは遅延の段階 (`topologyLagLevel`)、異常のあるノードは警告の意味色の枠。
 * 配置は `layoutTopology` (純関数)、ここは描画だけ。接続経路図 (`ConnectionPathDiagram`, #1754) と同じく
 * ノードのタイル + 線の充填 (`.conn-path-*`) の視覚言語で、手書きの svg は使わない。
 * 線は左から伸びて描き入れる (reduced-motion / hc-* は `App.css` 側で即時)。
 */

/** 段階 → 矢印の色。色だけに頼らず太さと遅延の文言でも伝える。 */
function edgeColor(level: TopologyLagLevel): string {
  switch (level) {
    case "ok":
      return semanticColorVar("success", "solid");
    case "slow":
      return semanticColorVar("info", "solid");
    case "warn":
      return semanticColorVar("warning", "solid");
    default:
      return "var(--text-muted)";
  }
}

const THICKNESS_TOKEN = { 1: "1", 2: "1.5", 3: "2.5" } as const;

/** マウント直後に 1 回だけ線を描き入れる (`.conn-path-fill[data-lit]`)。 */
function useDrawIn(): boolean {
  const [lit, setLit] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setLit(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return lit;
}

function Edge({ peer, lit }: { peer: TopologyPeer; lit: boolean }) {
  const color = edgeColor(peer.level);
  return (
    <Flex align="center" flex="1" minW="8" data-testid="topology-edge" data-level={peer.level}>
      <Box
        className="conn-path-edge"
        w="100%"
        h={THICKNESS_TOKEN[peer.thickness]}
        borderRadius="pill"
        overflow="hidden"
        bg="app.surfaceMuted"
      >
        <Box
          className="conn-path-fill"
          data-kind="plain"
          data-lit={lit ? "true" : "false"}
          h="100%"
          style={{ background: color }}
        />
      </Box>
      <chakra.span color={color} display="inline-flex" aria-hidden ml="-1">
        <Icon name="chevron-right" size={ICON_SIZES.md} />
      </chakra.span>
    </Flex>
  );
}

function PeerNode({ peer }: { peer: TopologyPeer }) {
  const t = useT();
  return (
    <Flex
      direction="column"
      gap="0.5"
      px="2.5"
      py="1.5"
      minW={0}
      w="40"
      borderRadius="md"
      borderWidth="2px"
      borderColor={peer.attention ? semanticColorToken("warning", "border") : "app.borderStrong"}
      bg={peer.attention ? semanticColorToken("warning", "subtle") : "app.surface"}
      data-testid="topology-peer"
      data-attention={peer.attention ? "true" : "false"}
    >
      <Flex align="center" gap="1.5" minW={0}>
        <chakra.span
          color={peer.attention ? "app.textWarning" : "app.textSecondary"}
          display="inline-flex"
          flexShrink={0}
          aria-hidden
        >
          <Icon name="server" size={ICON_SIZES.md} />
        </chakra.span>
        <chakra.span
          fontFamily="var(--font-mono)"
          fontSize="xs"
          fontWeight={600}
          color="app.text"
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
          title={peer.address ? `${peer.name} (${peer.address})` : peer.name}
        >
          {peer.name}
        </chakra.span>
      </Flex>
      <chakra.span
        textStyle="caption"
        color={peer.level === "warn" ? "app.textWarning" : "app.textMuted"}
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        <chakra.span textStyle="numeric">
          {peer.lagSecs === null ? t("replicationTopologyLagUnknown") : formatLagSecs(peer.lagSecs)}
        </chakra.span>
      </chakra.span>
    </Flex>
  );
}

function SelfNode({ driver }: { driver: DriverKind }) {
  const t = useT();
  const icon = driverIconName(driver);
  const accent = driverColor(driver);
  return (
    <Flex
      direction="column"
      align="center"
      gap="1"
      px="3"
      py="2"
      borderRadius="md"
      borderWidth="2px"
      bg="app.surface"
      style={{ borderColor: accent, color: accent }}
      data-testid="topology-self"
    >
      {icon && <Icon name={icon} size={ICON_SIZES.lg} />}
      <chakra.span textStyle="caption" color="app.text" whiteSpace="nowrap">
        {t("replicationTopologySelf")}
      </chakra.span>
    </Flex>
  );
}

function More({ count }: { count: number }) {
  const t = useT();
  if (count <= 0) return null;
  return (
    <chakra.span textStyle="caption" color="app.textMuted" data-testid="topology-more">
      {t("replicationTopologyMore", { count })}
    </chakra.span>
  );
}

export function ReplicationTopology({ links, driver }: { links: readonly KeyedLink[]; driver: DriverKind }) {
  const t = useT();
  const lit = useDrawIn();
  const layout = layoutTopology(links);
  if (layout.upstream.length === 0 && layout.downstream.length === 0) return null;

  const part = (peers: readonly TopologyPeer[]) =>
    peers
      .map(
        (p) =>
          `${p.name} (${p.lagSecs === null ? t("replicationTopologyLagUnknown") : formatLagSecs(p.lagSecs)})`,
      )
      .join(", ");
  const desc = [
    layout.upstream.length > 0
      ? `${t("replicationTopologyUpstreamHeading")}: ${part(layout.upstream)}`
      : null,
    layout.downstream.length > 0
      ? `${t("replicationTopologyDownstreamHeading")}: ${part(layout.downstream)}`
      : null,
  ]
    .filter(Boolean)
    .join(" / ");

  return (
    <Flex
      role="img"
      aria-label={t("replicationTopologyAria", { desc })}
      data-testid="replication-topology"
      align="center"
      gap="2"
      p="3"
      overflowX="auto"
      borderRadius="md"
      borderWidth="1px"
      borderColor="app.border"
      bg="app.surfaceMuted"
    >
      {layout.upstream.length > 0 && (
        <Flex direction="column" gap="2" data-testid="topology-upstream" flex="1" align="flex-end">
          {layout.upstream.map((p) => (
            <Flex key={p.key} align="center" w="100%" gap="2">
              <PeerNode peer={p} />
              <Edge peer={p} lit={lit} />
            </Flex>
          ))}
          <More count={layout.upstreamMore} />
        </Flex>
      )}
      <SelfNode driver={driver} />
      {layout.downstream.length > 0 && (
        <Flex direction="column" gap="2" data-testid="topology-downstream" flex="1">
          {layout.downstream.map((p) => (
            <Flex key={p.key} align="center" w="100%" gap="2">
              <Edge peer={p} lit={lit} />
              <PeerNode peer={p} />
            </Flex>
          ))}
          <More count={layout.downstreamMore} />
        </Flex>
      )}
    </Flex>
  );
}
