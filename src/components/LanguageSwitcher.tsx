import { Locale, setLocale, useLocale, useT } from "../i18n";
import { Segmented } from "./Segmented";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "ja", label: "日本語" },
];

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useT();
  return <Segmented value={locale} options={OPTIONS} onChange={setLocale} ariaLabel={t("appLanguage")} />;
}
