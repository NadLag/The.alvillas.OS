import { randomUUID } from "node:crypto";

type QueryClient = { $queryRawUnsafe(query: string): Promise<unknown> };

/** Measure the actual transaction's query events, including its BEGIN/COMMIT, after a causal event fence. */
export function transactionQueryMeasurement(client: QueryClient) {
  let boundary: { sql: string; done: () => void } | null = null;
  let active: { started: boolean; ended: boolean; queries: string[]; outside: string[]; done: () => void } | null = null;
  const observe = (query: string) => {
    if (boundary?.sql === query) { boundary.done(); return; }
    if (!active) return;
    if (/^BEGIN(?:\s|$)/iu.test(query.trim()) && !active.started) active.started = true;
    if (!active.started || active.ended) { active.outside.push(query); return; }
    active.queries.push(query);
    if (/^(?:COMMIT|ROLLBACK)\s*;?$/iu.test(query.trim())) { active.ended = true; active.done(); }
  };
  const measure = async <T>(work: () => Promise<T>) => {
    if (active || boundary) throw Error("Query measurements must be sequential");
    const sql = "SELECT 1 /* transaction_measurement_" + randomUUID() + " */";
    const fenced = new Promise<void>(resolve => { boundary = { sql, done: resolve }; });
    try { await Promise.all([client.$queryRawUnsafe(sql), fenced]); } finally { boundary = null; }
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const observation = { started: false, ended: false, queries: [] as string[], outside: [] as string[], done: complete };
    active = observation;
    try {
      const value = await work(); await completed;
      if (!observation.started || !/^COMMIT\s*;?$/iu.test(observation.queries.at(-1)?.trim() ?? "") ||
          observation.queries.filter(query => /^BEGIN(?:\s|$)/iu.test(query.trim())).length !== 1 ||
          observation.outside.some(query => !/^SELECT\s+1\s*;?$/iu.test(query.trim()))) throw Error("One complete isolated transaction is required for query measurement");
      return { value, queries: observation.queries, count: observation.queries.length, poolProbes: observation.outside.length };
    } finally { active = null; }
  };
  return { observe, measure };
}
