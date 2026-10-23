import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChakraProvider } from "@chakra-ui/react";
import { ConnectionPathDiagram } from "../components/ConnectionPathDiagram";
import { buildConnectionPath } from "../components/connectionPath";
import { system } from "../theme";

const path = buildConnectionPath({
  route: "ssh",
  host: "db.internal",
  port: 3306,
  ssh: { host: "bastion.example", port: 22 },
});

function renderDiagram(phase?: string) {
  return render(
    <ChakraProvider value={system}>
      <ConnectionPathDiagram path={path} driver="mysql" phase={phase} />
    </ChakraProvider>,
  );
}

describe("ConnectionPathDiagram", () => {
  it("静的表示: 全ノード done、ラベルに host:port が出る", () => {
    renderDiagram();
    expect(screen.getByTestId("conn-path-node-bastion").dataset.state).toBe("done");
    expect(screen.getByText("bastion.example:22")).toBeTruthy();
    expect(screen.getByText("db.internal:3306")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("bastion.example:22");
  });

  it("接続中: フェーズに応じて左から点灯する", () => {
    renderDiagram("tunnel_connecting");
    expect(screen.getByTestId("conn-path-node-local").dataset.state).toBe("done");
    expect(screen.getByTestId("conn-path-node-bastion").dataset.state).toBe("active");
    expect(screen.getByTestId("conn-path-node-target").dataset.state).toBe("pending");
  });
});
