import { type ReactNode, useEffect, useState } from "react";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { BrandMark } from "../brand";
import { Heading } from "./ui";

interface Props {
  title: ReactNode;
  subtitle: ReactNode;
  /** 見出しブロック全体の最大幅 (サブタイトルの折り返し幅)。既定 `52ch`。 */
  maxW?: string;
  /** 初回表示でマークのシグネチャ・アニメーションをワンショット再生する (#2042)。セッション内 1 回のみ。既定 false。 */
  animate?: boolean;
}

/** セッション内でヒーロー面のシグネチャ・アニメを再生済みか (Welcome → Profile の遷移でも 2 回目は静止)。 */
let heroAnimationPlayed = false;

/** テスト用: 再生済みフラグを戻す。 */
export function resetHeroAnimationForTest() {
  heroAnimationPlayed = false;
}

/**
 * `enabled` が初めて true になった時点でフラグを消費し、以降は再生状態を保つ。
 * スプラッシュ表示中 (enabled=false) の裏マウントではフラグを消費しない。
 */
function useOnceAnimate(enabled: boolean): boolean {
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (!enabled || heroAnimationPlayed) return;
    heroAnimationPlayed = true;
    setPlay(true);
  }, [enabled]);
  return play;
}

/**
 * ヒーロー見出し (#1955)。`BrandMark` + display 見出し + ブランド罫線 + サブタイトルを束ねる
 * 単一ソース。起動入口の双子画面 (`WelcomeView` / `ProfileCardGrid`) が共有し、保存プロファイルの
 * 有無でブランドの第一印象が揺らがないようにする。罫線の値は App.css の `--hero-rule` /
 * `--hero-rule-display` が単一ソース (hc-* では none)。
 */
export function HeroHeader({ title, subtitle, maxW = "52ch", animate = false }: Props) {
  const play = useOnceAnimate(animate);
  return (
    <Flex direction="column" align="center" gap="1.5" maxW={maxW} textAlign="center">
      <Flex align="center" gap="2">
        <BrandMark
          size={34}
          animate={play}
          width="calc(34px * var(--font-scale))"
          height="calc(34px * var(--font-scale))"
        />
        <Heading role="display">{title}</Heading>
      </Flex>
      {/* 見出し下のブランドグラデーションの短い罫線 (#1216 / #1891、hc-* では none) */}
      <chakra.div
        aria-hidden
        w="48px"
        h="3px"
        rounded="pill"
        css={{ background: "var(--hero-rule)", display: "var(--hero-rule-display)" }}
      />
      <Text textStyle="body" color="app.textMuted">
        {subtitle}
      </Text>
    </Flex>
  );
}
