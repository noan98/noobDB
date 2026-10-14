import { chakra } from "@chakra-ui/react";
import type { HealthFinding } from "../api/tauri";
import { useT } from "../i18n";
import { semanticColorToken } from "../semanticColors";
import { severityLabelKey, severityRole } from "./advisor";

// AdvisorPanel (アドバイザ本体と AI 解説を含む重い遅延読み込み対象) と AiExplainInterpret の
// 両方から使うため、小さな別モジュールに置く (#1608)。AdvisorPanel を import すると、
// EXPLAIN ビューアのチャンクに AdvisorPanel が静的に取り込まれて遅延読み込みが効かなくなる。
export function SeverityBadge({ severity }: { severity: HealthFinding["severity"] }) {
  const t = useT();
  const role = severityRole(severity);
  return (
    <chakra.span
      display="inline-block"
      px="2"
      py="0.5"
      textStyle="overline"
      lineHeight={1.4}
      borderRadius="var(--radius-sm)"
      whiteSpace="nowrap"
      bg={semanticColorToken(role, "subtle")}
      color={semanticColorToken(role, "text")}
      border="1px solid"
      borderColor={semanticColorToken(role, "border")}
    >
      {t(severityLabelKey(severity))}
    </chakra.span>
  );
}
