import Link from "next/link";
import { appLocales, compactLocaleLabels, localeLabels, type AppLocale } from "@/i18n/routing";

type LocaleSwitchProps = {
  currentLocale: AppLocale;
  path: string;
  label: string;
  compact?: boolean;
};

export function LocaleSwitch({
  currentLocale,
  path,
  label,
  compact = false
}: LocaleSwitchProps) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const labels = compact ? compactLocaleLabels : localeLabels;

  return (
    <nav className="locale-switch" aria-label={label} data-testid="locale-switch">
      {appLocales.map((locale) => (
        <Link
          aria-current={locale === currentLocale ? "page" : undefined}
          data-testid={`locale-switch-${locale}`}
          href={`/${locale}${normalizedPath}`}
          key={locale}
        >
          {labels[locale]}
        </Link>
      ))}
    </nav>
  );
}
