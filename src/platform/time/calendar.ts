import { z } from "zod";
import { calendarDateAt } from "@/i18n/format";

/** First instant of a property calendar date, using the installed IANA data. */
export function calendarDateStart(value: string, timezone: string): Date {
  const day = z.iso.date().parse(value), utc = new Date(`${day}T00:00:00.000Z`).getTime();
  const radius = 2 * 24 * 60 * 60 * 1000;
  let low = utc - radius, high = utc + radius;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (calendarDateAt(new Date(middle), timezone) < day) low = middle + 1; else high = middle;
  }
  const result = new Date(low);
  if (calendarDateAt(result, timezone) !== day) throw new Error("Calendar date does not exist in the property timezone");
  return result;
}
