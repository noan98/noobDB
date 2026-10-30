import { Component, type ErrorInfo, type ReactNode } from "react";
import { Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { EmptyState } from "./EmptyState";

/**
 * 全画面サーフェス (ER 図・スキーマ比較など) の描画中に起きた例外を受け止める境界。
 *
 * React は ErrorBoundary の無いツリーで描画中に例外が出ると**ルートごとアンマウント**する。
 * noobDB では背景色だけが残り「画面が真っ黒になる」ように見え、閉じる手段も無くなる。
 * サーフェス単位で受け止めれば、サイドバーやタブは生きたまま、エラー内容と
 * 「再試行 / 閉じる」を出せる。原因の特定にも使えるよう、エラーはコンソールにも残す。
 */
interface Props {
  /** フォールバックの「閉じる」。サーフェスの戻るボタンと同じ関数を渡す。 */
  onClose?: () => void;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SurfaceErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[SurfaceErrorBoundary]", error, info.componentStack);
  }

  private readonly reset = () => this.setState({ error: null });

  render(): ReactNode {
    if (this.state.error) {
      return (
        <SurfaceErrorFallback error={this.state.error} onRetry={this.reset} onClose={this.props.onClose} />
      );
    }
    return this.props.children;
  }
}

function SurfaceErrorFallback({
  error,
  onRetry,
  onClose,
}: {
  error: Error;
  onRetry: () => void;
  onClose?: () => void;
}) {
  const t = useT();
  return (
    <Flex flex="1" minH="0" align="center" justify="center" overflowY="auto" py="4">
      <EmptyState
        icon="warning"
        title={t("surfaceErrorTitle")}
        description={error.message || String(error)}
        action={{ label: t("surfaceErrorRetry"), onClick: onRetry }}
        secondaryActions={onClose ? [{ label: t("surfaceErrorClose"), onClick: onClose }] : undefined}
      />
    </Flex>
  );
}
