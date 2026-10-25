export function isStorageQuotaError(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if ("name" in current && current.name === "QuotaExceededError") return true;
    if ("inner" in current) pending.push(current.inner);
    if ("cause" in current) pending.push(current.cause);
  }
  return false;
}
