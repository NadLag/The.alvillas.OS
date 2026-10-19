import { describe, it, expect } from "vitest";
import { ICalAdapter, CSVAdapter, AirbnbAdapter, BookingComAdapter, VrboAdapter } from "@/modules/reservations/domain/adapters";
import { canTransition, changeReservationSchema, stayDateSchema } from "@/modules/reservations/domain/reservation";
import { feedUrl, publicAddress } from "@/modules/reservations/infrastructure/ical-transport";
import { externalKey, normalizedHash } from "@/modules/reservations/infrastructure/reservation-repository";
const context = { source: "AIRBNB" as const, timezone: "Africa/Casablanca" };
const calendar = (...events: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.map(event => `BEGIN:VEVENT\r\n${event}\r\nEND:VEVENT`), "END:VCALENDAR"].join("\r\n");
const event = "UID:stable-id\r\nDTSTART;VALUE=DATE:20270410\r\nDTEND;VALUE=DATE:20270414\r\nSUMMARY:Reserved";
const parse = (content: string) => new ICalAdapter().normalize({ ...context, content });

describe("normalized reservation adapters", () => {
  it("imports iCal dates without inventing guests, amounts or payouts", () => {
    const [entry] = parse(calendar(`${event}\r\nDESCRIPTION:Guest: Someone\\nPrice: 900 MAD`));
    expect(entry).toMatchObject({ kind: "reservation", externalId: "stable-id", guestName: null, guestEmail: null, guestPhone: null, quote: null, checkIn: "2027-04-10", checkOut: "2027-04-14" });
    expect(entry).not.toHaveProperty("payout");
  });
  it("treats unavailable dates as blocks and uses a stable fallback when UID is absent", () => {
    const [entry] = parse(calendar(event.replace("UID:stable-id\r\n", "").replace("Reserved", "Not available")));
    expect(entry.kind).toBe("block"); expect(entry.externalId).toBeNull();
    expect(externalKey(entry)).toBe("dates:block:2027-04-10:2027-04-14");
    expect(normalizedHash(entry)).toBe(normalizedHash(parse(calendar(event.replace("UID:stable-id\r\n", "").replace("Reserved", "Not available")))[0]));
  });
  it("preserves all-day property dates, unfolds lines, and extracts an explicit booking code", () => {
    const [entry] = parse(calendar(`${event}\r\nDESCRIPTION:Reservation ID: HM\r\n 12345`));
    expect(entry.externalId).toBe("HM12345"); expect(entry.checkOut).toBe("2027-04-14");
  });
  it("uses property timezone for UTC instants and keeps checkout exclusive", () => {
    const [entry] = new ICalAdapter().normalize({ source: "VRBO", timezone: "America/New_York", content: calendar(event.replace("DTSTART;VALUE=DATE:20270410", "DTSTART:20270410T010000Z").replace("DTEND;VALUE=DATE:20270414", "DTEND:20270414T010000Z")) });
    expect(entry.checkIn).toBe("2027-04-09"); expect(entry.checkOut).toBe("2027-04-13");
  });
  it("selects the latest UID sequence and recognizes explicit cancellation", () => {
    const entries = parse(calendar(`${event}\r\nSEQUENCE:1`, `${event}\r\nSEQUENCE:2\r\nSTATUS:CANCELLED`));
    expect(entries).toHaveLength(1); expect(entries[0].cancelled).toBe(true); expect(entries[0].sequence).toBe(2);
  });
  it("converts explicit IANA timezone instants into the property calendar", () => {
    const content = calendar(event.replace("DTSTART;VALUE=DATE:20270410", "DTSTART;TZID=Asia/Tokyo:20270410T003000").replace("DTEND;VALUE=DATE:20270414", "DTEND;TZID=Asia/Tokyo:20270414T003000"));
    expect(parse(content)[0]).toMatchObject({ checkIn: "2027-04-09", checkOut: "2027-04-13" });
    expect(() => parse(calendar(event.replace("DTSTART;VALUE=DATE:20270410", "DTSTART:20270410T250000")))).toThrow();
    expect(() => parse(content.replaceAll("Asia/Tokyo", "Invalid/Timezone"))).toThrow();
  });
  it("ignores nested reminder descriptions and preserves the booking event", () => {
    const [entry] = parse(calendar(`${event}\r\nBEGIN:VALARM\r\nSUMMARY:Not available\r\nDESCRIPTION:Reservation ID: FALSE\r\nEND:VALARM`));
    expect(entry).toMatchObject({ kind: "reservation", externalId: "stable-id" });
  });
  it.each([
    ["20071104T013000", "20071108T013000", "America/Guatemala", "2007-11-03"],
    ["20070311T023000", "20070315T023000", "America/Phoenix", "2007-03-11"]
  ])("resolves RFC 5545 repeated and skipped wall times for %s", (start, end, timezone, expected) => {
    const content = calendar(`UID:dst-example\r\nDTSTART;TZID=America/New_York:${start}\r\nDTEND;TZID=America/New_York:${end}\r\nSUMMARY:Reserved`);
    expect(new ICalAdapter().normalize({ source: "VRBO", timezone, content })[0].checkIn).toBe(expected);
  });
  it("rejects ambiguous UIDs and malformed/truncated feeds instead of inferring cancellations", () => {
    for (const content of ["not a calendar", calendar(event).replace("END:VEVENT", ""), calendar(event, event.replace("20270414", "20270415")), calendar(event.replace("20270410", "20270230")), calendar(`${event}\r\nRRULE:FREQ=DAILY`)]) expect(() => parse(content)).toThrow();
    expect(parse(calendar())).toEqual([]);
  });
  it.each([CSVAdapter, AirbnbAdapter, BookingComAdapter, VrboAdapter])("normalizes real column names and quoted CSV through %s", Adapter => {
    const rows = new Adapter().normalize({ ...context, content: '\uFEFFConfirmation code,Start date,End date,Guest,Currency,Gross earnings\r\nHM123,2027-04-10,2027-04-14,"Smith, Jo",MAD,5500.25' });
    expect(rows[0]).toMatchObject({ externalId: "HM123", guestName: "Smith, Jo", quote: { amount: "5500.25", currency: "MAD" } });
  });
  it("does not fabricate guest names in CSV and recognizes cancellation and draft states", () => {
    const rows = new CSVAdapter().normalize({ ...context, content: "external_id;check_in;check_out;status\r\na;2027-04-10;2027-04-14;cancelled\r\nb;2027-05-10;2027-05-14;imported" });
    expect(rows[0]).toMatchObject({ cancelled: true, guestName: null, quote: null }); expect(rows[1].initialState).toBe("IMPORTED");
  });
  it.each(["external_id,check_in,check_out\na,2027-04-10", "check_in,check_in\na,b", "check_in,check_out,amount\n2027-04-10,2027-04-14,40", 'check_in,check_out,guest\n2027-04-10,2027-04-14,"unterminated']) ("rejects incomplete CSV without partial import: %s", content => expect(() => new CSVAdapter().normalize({ ...context, content })).toThrow());
});

describe("reservation lifecycle and feed boundaries", () => {
  it("permits only lifecycle edges and explicit side exits", () => {
    expect(canTransition("IMPORTED", "CONFIRMED")).toBe(true); expect(canTransition("CONFIRMED", "CANCELLED")).toBe(true);
    expect(canTransition("STAYING", "CANCELLED")).toBe(false); expect(canTransition("CONFIRMED", "CLOSED")).toBe(false);
    expect(canTransition("CANCELLED", "CONFIRMED")).toBe(false); expect(canTransition("CLOSED", "STAYING")).toBe(false);
  });
  it.each(["2027-02-29", "2026-13-01", "2026-04-31", "2026-00-10"])("rejects impossible property stay date %s", value => expect(stayDateSchema.safeParse(value).success).toBe(false));
  it("requires reason, version and target status for changes", () => expect(changeReservationSchema.safeParse({ operation: "TRANSITION", expectedVersion: 0 }).success).toBe(false));
  it.each(["https://127.0.0.1/feed", "https://[::1]/feed", "http://airbnb.com/feed", "https://10.1.2.3/feed", "https://host.internal/feed", "https://user:password@airbnb.com/feed", "https://airbnb.com:8443/feed"])("rejects unsafe feed URL %s", value => expect(() => feedUrl(value)).toThrow());
  it("excludes private, mapped and metadata DNS results", () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "172.16.10.1", "192.168.1.1", "100.64.1.1", "::ffff:127.0.0.1", "fc00::1", "fe80::1"]) expect(publicAddress(address)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true); expect(feedUrl("https://www.airbnb.com/calendar/ical/123.ics?s=private").protocol).toBe("https:");
  });
});
