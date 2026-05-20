import { Locale, setLocale, useLocale } from "../i18n";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "ja", label: "日本語" },
];

export function LanguageSwitcher() {
  const locale = useLocale();
  return (
    <div className="lang-switch" role="group" aria-label="Language">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          className={`lang-btn ${locale === o.value ? "active" : ""}`}
          onClick={() => setLocale(o.value)}
          aria-pressed={locale === o.value}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
