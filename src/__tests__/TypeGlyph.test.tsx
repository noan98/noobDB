import { beforeEach, describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { kindOfDataType, TypeGlyph } from "../components/TypeGlyph";
import { setLocale, t } from "../i18n";

// 型グリフ (#2125)。分類は ER 図と同じ関数経由、読み上げは型ファミリー名。
describe("TypeGlyph (#2125)", () => {
  beforeEach(() => setLocale("en"));

  it("正式名・修飾付きの型名も ER 図と同じ型ファミリーへ分類する", () => {
    expect(kindOfDataType("bigint unsigned")).toBe("number");
    expect(kindOfDataType("numeric(10,2)")).toBe("decimal");
    expect(kindOfDataType("timestamp with time zone")).toBe("date");
    expect(kindOfDataType("bytea")).toBe("binary");
    expect(kindOfDataType("jsonb")).toBe("json");
    expect(kindOfDataType("character varying(255)")).toBe("string");
  });

  it("型ファミリー名を aria-label で公開する", () => {
    renderWithProviders(<TypeGlyph kind="date" />);
    expect(screen.getByRole("img", { name: t("colTypeDate") })).toBeTruthy();
  });
});
