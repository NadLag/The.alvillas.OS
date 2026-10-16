// Morocco's September 2026 transition is present from IANA 2026c. Older
// embedded ICU databases silently schedule Casablanca notifications an hour early.
export function currentTimezoneData(version = process.versions.tz): boolean {
  return typeof version === "string" && /^\d{4}[a-z]+$/u.test(version) && version >= "2026c";
}
export function requireCurrentTimezoneData(): void {
  if (!currentTimezoneData()) throw new Error("digest_timezone_data_outdated");
}
