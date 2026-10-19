import type { NormalizedReservationAdapter, ReservationAdapterInput } from "@/platform/providers/reservation-types";
import { csvRecords } from "@/platform/imports/csv";
import { normalizedReservationSchema, type NormalizedReservation, stayDateSchema } from "./reservation";

function date(value: string, format: "ISO" | "MDY" | "DMY" = "ISO"): string {
  if (format !== "ISO" && !/^\d{4}-/u.test(value)) {
    const match = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/u.exec(value);
    if (!match) throw new Error("csv_date_format_mismatch");
    value = `${match[3]}-${String(format === "MDY" ? match[1] : match[2]).padStart(2, "0")}-${String(format === "MDY" ? match[2] : match[1]).padStart(2, "0")}`;
  }
  if (/^\d{8}$/u.test(value)) value = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return stayDateSchema.parse(value);
}
function icalDate(value: string, timezone: string, sourceTimezone?: string): string {
  if (/^\d{8}$/u.test(value)) return date(value);
  const match = /^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/u.exec(value);
  if (!match) throw new Error("invalid_ical_date");
  const day = date(match[1]);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 60 || (sourceTimezone && match[5])) throw new Error("invalid_ical_date");
  if (!match[5] && !sourceTimezone) return day; // Floating times use the property's local calendar.
  const wall = Date.parse(`${day}T${match[2]}:${match[3]}:${Math.min(59, Number(match[4])).toString().padStart(2, "0")}Z`);
  let instant = new Date(wall);
  if (sourceTimezone) {
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: sourceTimezone, timeZoneName: "longOffset" });
    const offset = (at: number) => {
      const zone = formatter.formatToParts(at).find(part => part.type === "timeZoneName")?.value ?? "";
      if (zone === "GMT") return 0;
      const parts = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(zone);
      if (!parts) throw new Error("unsupported_ical_timezone");
      return (parts[1] === "+" ? 1 : -1) * (Number(parts[2]) * 3600 + Number(parts[3]) * 60 + Number(parts[4] ?? 0)) * 1000;
    };
    const offsets = [...new Set([-36, 0, 36].map(hours => offset(wall + hours * 3600000)))];
    const candidates = offsets.map(value => wall - value).filter(value => value + offset(value) === wall).sort((a, b) => a - b);
    // RFC 5545 §3.3.5: first occurrence on folds, pre-gap offset on skipped times.
    instant = new Date(candidates[0] ?? wall - offset(wall - 36 * 3600000));
  }
  if (Number.isNaN(instant.getTime())) throw new Error("invalid_ical_date");
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}
function unescapeIcal(value: string): string { return value.replace(/\\[nN]/gu, "\n").replace(/\\([,;\\])/gu, "$1"); }

export class ICalAdapter implements NormalizedReservationAdapter {
  normalize({ content, source, timezone }: ReservationAdapterInput): NormalizedReservation[] {
    if (content.length > 2_000_000) throw new Error("feed_too_large");
    const lines = content.replace(/\r\n[ \t]|\n[ \t]/gu, "").replace(/\r\n/gu, "\n").split("\n").map(line => line.replace(/\r$/u, ""));
    if (!lines.includes("BEGIN:VCALENDAR") || !lines.includes("END:VCALENDAR")) throw new Error("invalid_ical_calendar");
    const entries: NormalizedReservation[] = [];
    let event: Map<string, string> | null = null, nested = 0;
    for (const line of lines) {
      if (line === "BEGIN:VEVENT") { if (event) throw new Error("invalid_ical_event"); event = new Map(); continue; }
      if (line === "END:VEVENT") {
        if (!event || nested) throw new Error("invalid_ical_event");
        if (event.has("RRULE") || event.has("RDATE") || event.has("RECURRENCE-ID")) throw new Error("unsupported_ical_recurrence");
        const start = event.get("DTSTART"), end = event.get("DTEND");
        if (!start || !end) throw new Error("invalid_ical_stay");
        const summary = event.get("SUMMARY") ?? "";
        const description = unescapeIcal(event.get("DESCRIPTION") ?? "");
        // Only a provider reservation link/code proves a booking. Generic unavailable events are blocks.
        const code = event.get("X-RESERVATION-ID") ?? /(?:confirmation(?:[ _]code)?|reservation(?:[ _]id)?)[=: ]+([A-Z0-9-]+)/iu.exec(description)?.[1]
          ?? /(?:airbnb\.[a-z.]+\/hosting\/reservations\/details|booking\.[a-z.]+\/.*reservation)[/=?]+([A-Z0-9-]+)/iu.exec(description)?.[1];
        const block = /not available|unavailable|blocked|indisponible|non disponible/iu.test(summary);
        entries.push(normalizedReservationSchema.parse({ kind: !block && (code || /reserved|réservé|reservation|booking/iu.test(summary)) ? "reservation" : "block", source,
          externalId: code ?? (event.get("UID")?.trim() || null), checkIn: icalDate(start, timezone, event.get("DTSTART-TZID")), checkOut: icalDate(end, timezone, event.get("DTEND-TZID")),
          cancelled: event.get("STATUS") === "CANCELLED", sequence: event.has("SEQUENCE") ? Number(event.get("SEQUENCE")) : null }));
        if (entries.length > 5000) throw new Error("feed_too_many_events");
        event = null; continue;
      }
      if (event) {
        if (line.startsWith("BEGIN:")) { nested++; continue; }
        if (line.startsWith("END:") && nested) { nested--; continue; }
        if (nested) continue;
        const colon = line.indexOf(":"); if (colon < 0) { if (line) throw new Error("invalid_ical_property"); continue; }
        const key = line.slice(0, colon).split(";")[0].toUpperCase();
        const tzid = /;TZID=(?:"([^"]+)"|([^;:]+))/iu.exec(line.slice(0, colon));
        if (tzid && ["DTSTART", "DTEND"].includes(key)) event.set(`${key}-TZID`, tzid[1] ?? tzid[2]);
        if (event.has(key) && ["UID", "DTSTART", "DTEND", "SEQUENCE"].includes(key)) throw new Error("duplicate_ical_property");
        event.set(key, line.slice(colon + 1));
      }
    }
    if (event) throw new Error("incomplete_ical_event");
    const byIdentity = new Map<string, NormalizedReservation>();
    for (const entry of entries) {
      const key = entry.externalId ?? `${entry.kind}:${entry.checkIn}:${entry.checkOut}`;
      const prior = byIdentity.get(key);
      if (prior && (entry.sequence ?? 0) === (prior.sequence ?? 0) && JSON.stringify(prior) !== JSON.stringify(entry)) throw new Error("ambiguous_ical_uid");
      if (!prior || (entry.sequence ?? 0) >= (prior.sequence ?? 0)) byIdentity.set(key, entry);
    }
    return [...byIdentity.values()];
  }
}

const pick = (row: Record<string, string>, ...keys: string[]) => keys.map(key => row[key]).find(Boolean) ?? null;
export class CSVAdapter implements NormalizedReservationAdapter {
  normalize({ content, source, dateFormat }: ReservationAdapterInput): NormalizedReservation[] {
    return csvRecords(content).map(row => {
      const checkIn = pick(row, "check_in", "start_date", "arrival", "arrival_date", "arrival_date_(yyyy-mm-dd)");
      const checkOut = pick(row, "check_out", "end_date", "departure", "departure_date", "departure_date_(yyyy-mm-dd)");
      if (!checkIn || !checkOut) throw new Error("csv_missing_stay_dates");
      const status = pick(row, "status", "reservation_status", "type") ?? "";
      const amount = pick(row, "amount", "gross_amount", "gross_earnings"), currency = pick(row, "currency");
      if (Boolean(amount) !== Boolean(currency)) throw new Error("csv_incomplete_money");
      const guestName = pick(row, "guest_name", "guest", "guest's_name", "booker_name");
      return normalizedReservationSchema.parse({ kind: /block|owner|maintenance/iu.test(status) ? "block" : "reservation", source,
        initialState: /pending|inquiry|imported|request/iu.test(status) ? "IMPORTED" : "CONFIRMED",
        externalId: pick(row, "external_id", "confirmation_code", "reservation_id", "reservation_number", "booking_number", "reservation_#"),
        checkIn: date(checkIn, dateFormat), checkOut: date(checkOut, dateFormat), guestName,
        guestEmail: pick(row, "guest_email", "email"), guestPhone: pick(row, "guest_phone", "phone"),
        adultCount: pick(row, "adults", "adult_count") ? Number(pick(row, "adults", "adult_count")) : null,
        childCount: pick(row, "children", "child_count") ? Number(pick(row, "children", "child_count")) : null,
        cancelled: /cancelled|canceled|annulé/iu.test(status), quote: amount && currency ? { amount, currency } : null });
    });
  }
}
export class AirbnbAdapter extends CSVAdapter {}
export class BookingComAdapter extends CSVAdapter {}
export class VrboAdapter extends CSVAdapter {}
export class DirectBookingAdapter implements NormalizedReservationAdapter {
  normalize({ content }: ReservationAdapterInput): NormalizedReservation[] { return [normalizedReservationSchema.parse(JSON.parse(content) as unknown)]; }
}
