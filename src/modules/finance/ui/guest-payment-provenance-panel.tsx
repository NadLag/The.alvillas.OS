"use client";
import { useTranslations } from "next-intl";
import { formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import type { GuestDepositDetail } from "../domain/guest-deposit-workspace";

export function GuestPaymentProvenancePanel({ detail, locale }: { detail: GuestDepositDetail; locale: AppLocale }) {
  const t = useTranslations("GuestDeposits"), reservations = useTranslations("Reservations"), provenance = detail.provenance, summary = detail.summary;
  if (!provenance) return <p data-testid="deposit-provenance-historical">{t("provenanceHistorical")}</p>;
  const sources = reservations.raw("sources") as Record<string, string>, hidden = t("provenanceNameRestricted");
  return <section className="resource-form" data-testid="deposit-provenance">
    <h3>{t("provenanceTitle")}</h3><p>{t("provenanceOwnerContext")}</p>
    <dl className="compensation-evidence">
      <div><dt>{t("provenanceCollectedBy")}</dt><dd dir="auto" data-testid="provenance-collector">{provenance.organizationName} · {provenance.collectorName ?? hidden}</dd></div>
      <div><dt>{t("provenanceRecordedBy")}</dt><dd dir="auto">{provenance.recordedByName ?? hidden}</dd></div>
      <div><dt>{t("provenanceAccount")}</dt><dd dir="auto" data-testid="provenance-account">{provenance.accountName}</dd></div>
      <div><dt>{t("provenanceOwners")}</dt><dd dir="auto" data-testid="provenance-owners">{new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(provenance.owners.map(owner => owner.name ?? hidden))}</dd></div>
      <div><dt>{t("provenanceProperty")}</dt><dd dir="auto">{summary.propertyName}</dd></div>
      <div><dt>{t("provenanceReservation")}</dt><dd dir="auto">{summary.reservationReference}</dd></div>
      <div><dt>{t("provenanceGuest")}</dt><dd dir="auto">{summary.guestName ?? hidden}</dd></div>
      <div><dt>{t("provenanceSource")}</dt><dd dir="auto" data-testid="provenance-source">{sources[provenance.bookingSource] ?? provenance.bookingSource}</dd></div>
      <div><dt>{t("purpose")}</dt><dd dir="auto">{summary.purpose}</dd></div>
      <div><dt>{t("receivedAtUtc")}</dt><dd><time dateTime={provenance.receivedAt}>{formatDateTime(locale, new Date(provenance.receivedAt), { timeZone: "UTC" })}</time></dd></div>
    </dl>
  </section>;
}
