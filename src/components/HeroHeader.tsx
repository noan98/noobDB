import type { ReactNode } from "react";
import { chakra, Flex, Text } from "@chakra-ui/react";
import { BrandMark } from "../brand";
import { Heading } from "./ui";

interface Props {
  title: ReactNode;
  subtitle: ReactNode;
  /** 見出しブロック全体の最大幅 (サブタイトルの折り返し幅)。既定 `52ch`。 */
  maxW?: string;
}

/**
 * ヒーロー見出し (#1955)。`BrandMark` + display 見出し + ブランド罫線 + サブタイトルを束ねる
 * 単一ソース。起動入口の双子画面 (`WelcomeView` / `ProfileCardGrid`) が共有し、保存プロファイルの
 * 有無でブランドの第一印象が揺らがないようにする。罫線の値は App.css の `--hero-rule` /
 * `--hero-rule-display` が単一ソース (hc-* では none)。
 */
export function HeroHeader({ title, subtitle, maxW = "52ch" }: Props) {
  return (
    <Flex direction="column" align="center" gap="1.5" maxW={maxW} textAlign="center">
      <Flex align="center" gap="2">
        <BrandMark size={34} width="calc(34px * var(--font-scale))" height="calc(34px * var(--font-scale))" />
        <Heading role="display">{title}</Heading>
      </Flex>
      {/* 見出し下のブランドグラデーションの短い罫線 (#1216、hc-* では none) */}
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
