import { chakra } from "@chakra-ui/react";
import { Locale, setLocale, useLocale } from "../i18n";

const OPTIONS: { value: Locale; label: string }[] = [
  { value: "en", label: "EN" },
  { value: "ja", label: "日本語" },
];

export function LanguageSwitcher() {
  const locale = useLocale();
  return (
    <chakra.div display="inline-flex" gap="var(--space-1)" role="group" aria-label="Language">
      {OPTIONS.map((o) => {
        const active = locale === o.value;
        return (
          <chakra.button
            key={o.value}
            type="button"
            px="8px"
            py="2px"
            fontSize="var(--text-xs)"
            border="1px solid"
            borderColor={active ? "app.accent" : "app.borderStrong"}
            bg={active ? "app.accent" : "app.surface"}
            color={active ? "app.accentText" : "app.text"}
            borderRadius="sm"
            cursor="pointer"
            onClick={() => setLocale(o.value)}
            aria-pressed={active}
          >
            {o.label}
          </chakra.button>
        );
      })}
    </chakra.div>
  );
}
