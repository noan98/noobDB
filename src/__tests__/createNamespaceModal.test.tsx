import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { CreateNamespaceModal } from "../components/CreateNamespaceModal";
import { t } from "../i18n";

describe("CreateNamespaceModal (#1190)", () => {
  const base = { readOnly: false, onRun: () => {}, onSendToEditor: () => {}, onClose: () => {} };

  it("previews and runs a MySQL CREATE DATABASE", () => {
    const onRun = vi.fn();
    renderWithProviders(<CreateNamespaceModal {...base} driver="mysql" onRun={onRun} />);
    fireEvent.change(screen.getByLabelText(t("createNamespaceName")), { target: { value: "shop" } });
    expect(screen.getByText("CREATE DATABASE `shop`;")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("createNamespaceRun") }));
    expect(onRun).toHaveBeenCalledWith("CREATE DATABASE `shop`;", "database", "shop");
  });

  it("lets PostgreSQL pick SCHEMA and quotes the identifier", () => {
    renderWithProviders(<CreateNamespaceModal {...base} driver="postgres" initialKind="schema" />);
    fireEvent.change(screen.getByLabelText(t("createNamespaceName")), { target: { value: "au dit" } });
    expect(screen.getByText('CREATE SCHEMA "au dit";')).toBeInTheDocument();
  });

  it("disables the run button on a read-only session", () => {
    renderWithProviders(<CreateNamespaceModal {...base} driver="mysql" readOnly />);
    fireEvent.change(screen.getByLabelText(t("createNamespaceName")), { target: { value: "shop" } });
    expect(screen.getByRole("button", { name: t("createNamespaceRun") })).toBeDisabled();
    expect(screen.getByText(t("createTableReadOnly"))).toBeInTheDocument();
  });
});
