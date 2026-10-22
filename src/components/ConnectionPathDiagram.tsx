import { Box, Flex, Text } from "@chakra-ui/react";
import { BrandMark } from "../brand";
import { useT } from "../i18n";
import { driverColor, driverIconName } from "../profileIdentity";
import { Icon, ICON_SIZES, type IconName } from "./Icon";
import {
  activeIndexForPhase,
  describePath,
  edgeLitAt,
  nodeStateAt,
  type ConnectionPath,
  type PathEdgeKind,
  type PathNode,
  type PathNodeKind,
} from "./connectionPath";

/**
 * 接続経路図 (#1754)。「ローカル → (踏み台 / 多段 jump) → 目標 DB」を、ブランドロゴ
 * 「n Tunnel」の図像言語 (紺タイル + ティールの横線 = トンネル) で水平に描く純表示
 * コンポーネント。経路の組み立ては `connectionPath.ts`、ここは描画だけ。
 *
 * - `phase` を渡すと接続確立中の表示になり、ホップを左から順に点灯させる (済 / 進行中 /
 *   未到達)。省略すると全ホップ点灯の静的プレビュー (接続フォーム / 確立後)。
 * - 線の点灯とノードの脈動は `App.css` の `.conn-path-*`。reduced-motion / `hc-*` では
 *   静止する (最終状態のまま)。
 * - 色・余白・角丸はトークンのみ。SVG は `currentColor` / CSS 変数経由。
 * - 図に出す値は非秘密フィールド (ホスト・ポート・SSM ターゲット) だけ。
 */
export interface ConnectionPathDiagramProps {
  path: ConnectionPath;
  /** 目標 DB のドライバ (グリフと識別色を決める)。 */
  driver: string;
  /** 目標ノードの識別色 (プロファイルの色)。省略時はドライバ色。 */
  accentColor?: string | null;
  /** 接続フェーズ (#684)。省略 = 静的表示 (全ホップ点灯)。 */
  phase?: string;
  /** コンパクト表示 (フッター用)。ラベルを出さずタイルを小さくする。 */
  compact?: boolean;
}

const GLYPHS: Record<Exclude<PathNodeKind, "local" | "target">, IconName> = {
  jump: "server",
  bastion: "server",
  ssm: "server",
};

export function ConnectionPathDiagram({
  path,
  driver,
  accentColor,
  phase,
  compact = false,
}: ConnectionPathDiagramProps) {
  const t = useT();
  const active = phase === undefined ? null : activeIndexForPhase(path.nodes.length, phase);
  const accent = accentColor?.trim() || driverColor(driver);
  const tile = compact ? "5" : "8";

  const roleName = (kind: PathNodeKind): string => {
    switch (kind) {
      case "local":
        return t("pathLocal");
      case "jump":
        return t("pathJump");
      case "bastion":
        return t("pathBastion");
      case "ssm":
        return t("pathSsm");
      default:
        return t("pathTarget");
    }
  };
  const nodeText = (node: PathNode): string =>
    node.kind === "local" ? roleName("local") : (node.label ?? `${roleName(node.kind)} (${t("pathUnset")})`);

  const glyph = (node: PathNode, state: string) => {
    if (node.kind === "local") return <BrandMark size={compact ? 20 : 32} />;
    const icon = node.kind === "target" ? driverIconName(driver) : GLYPHS[node.kind];
    return (
      <Flex
        className="conn-path-tile"
        data-state={state}
        boxSize={tile}
        align="center"
        justify="center"
        flexShrink={0}
        borderRadius="md"
        border="2px solid"
        borderColor={node.kind === "target" ? undefined : "app.borderStrong"}
        bg="app.surface"
        color={node.kind === "target" ? undefined : "app.textSecondary"}
        style={node.kind === "target" ? { borderColor: accent, color: accent } : undefined}
      >
        {icon && <Icon name={icon} size={compact ? ICON_SIZES.sm : ICON_SIZES.lg} />}
      </Flex>
    );
  };

  const edge = (kind: PathEdgeKind, lit: boolean, key: string) => (
    <Flex key={key} flex="1" minW={compact ? "3" : "6"} h={tile} align="center" alignSelf="flex-start">
      <Box
        className="conn-path-edge"
        data-kind={kind}
        w="100%"
        h={compact ? "1" : "2"}
        borderRadius="pill"
        border="1px solid"
        borderColor="app.borderStrong"
        overflow="hidden"
      >
        <Box className="conn-path-fill" data-kind={kind} data-lit={lit ? "true" : "false"} h="100%" />
      </Box>
    </Flex>
  );

  const items = path.nodes.flatMap((node, i) => {
    const state = nodeStateAt(i, active);
    const out = [
      <Flex
        key={`n${i}`}
        direction="column"
        align="center"
        gap="1"
        minW={0}
        maxW={compact ? undefined : "44"}
        data-testid={`conn-path-node-${node.kind}`}
        data-state={state}
      >
        <Box className="conn-path-node" data-state={state} borderRadius="md" display="flex">
          {glyph(node, state)}
        </Box>
        {!compact && (
          <>
            <Text m="0" fontSize="2xs" color="app.textMuted" lineHeight="1.2">
              {roleName(node.kind)}
            </Text>
            {node.kind !== "local" && (
              <Text
                m="0"
                fontSize="xs"
                color={node.label ? "app.text" : "app.textMuted"}
                lineHeight="1.2"
                maxW="100%"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
                title={node.label ?? undefined}
              >
                {node.label ?? t("pathUnset")}
              </Text>
            )}
          </>
        )}
      </Flex>,
    ];
    if (i < path.edges.length) out.push(edge(path.edges[i], edgeLitAt(i, active), `e${i}`));
    return out;
  });

  return (
    <Flex
      role="img"
      aria-label={t("pathAria", { path: describePath(path, nodeText) })}
      data-testid="connection-path-diagram"
      data-phase={phase}
      align="flex-start"
      gap={compact ? "1" : "2"}
      w="100%"
      minW={0}
    >
      {items}
    </Flex>
  );
}
