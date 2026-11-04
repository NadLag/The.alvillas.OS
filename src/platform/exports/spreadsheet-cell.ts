/** Preserve source text while preventing a spreadsheet from interpreting it as a formula. */
export function spreadsheetText(value: string): string {
  return /^[=+@-]/u.test(value.replace(/^[\s\p{Cc}\p{Cf}]*/u, "")) ? "'" + value : value;
}

export function spreadsheetCsvCell(value: string, numeric = false): string {
  const safe = numeric ? value : spreadsheetText(value);
  return '"' + safe.replaceAll('"', '""') + '"';
}
