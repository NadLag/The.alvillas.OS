/** RFC 4180 records, with UTF-8 BOM and comma/semicolon/tab exports. */
export function parseCsv(csv: string): string[][] {
  csv = csv.replace(/^\uFEFF/u, "");
  const first = csv.split(/\r?\n/u, 1)[0];
  const delimiter = [",", ";", "\t"].reduce((best, item) => first.split(item).length > first.split(best).length ? item : best, ",");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const finish = () => { row.push(field); if (row.some(cell => cell.trim())) rows.push(row); row = []; field = ""; closed = false; };
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (char === '"') {
      if (quoted && csv[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) { quoted = false; closed = true; }
      else if (!field && !closed) quoted = true;
      else throw new Error("invalid_csv_quotes");
    } else if (!quoted && char === delimiter) { row.push(field); field = ""; closed = false; }
    else if (!quoted && (char === "\n" || char === "\r")) { if (char === "\r" && csv[i + 1] === "\n") i++; finish(); }
    else { if (closed && !/\s/u.test(char)) throw new Error("invalid_csv_quotes"); field += char; }
    if (rows.length > 5000) throw new Error("csv_too_many_rows");
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  finish();
  return rows;
}
export function csvRecords(csv: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(csv);
  if (!header || !rows.length) throw new Error("empty_csv");
  const keys = header.map(value => value.trim().toLowerCase().replace(/[\s-]+/gu, "_"));
  if (new Set(keys).size !== keys.length || keys.some(value => !value)) throw new Error("invalid_csv_headers");
  return rows.map(row => {
    if (row.length !== keys.length) throw new Error("invalid_csv_columns");
    return Object.fromEntries(keys.map((key, i) => [key, row[i].trim()]));
  });
}
