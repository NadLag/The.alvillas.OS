import { readBoundedRequestBytes } from "@/platform/http/read-exact-response";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { BankStatementAccessError, BankStatementValidationError } from "../domain/bank-statement";

/** Same-origin private multipart transport; original names and financial bytes never enter URLs or logs. */
export async function readBankStatementBody(request: Request): Promise<{ input: unknown; bytes: Uint8Array }> {
  if (!isSameOriginContentType(request, "multipart/form-data")) throw new BankStatementAccessError();
  try {
    const bytes = await readBoundedRequestBytes(request, 10 * 1024 * 1024 + 16384);
    const form = await new Response(new Uint8Array(bytes), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData();
    const entries = [...form.entries()];
    if (entries.length !== 2 || new Set(entries.map(([key]) => key)).size !== 2 || !form.has("input") || !form.has("file")) throw new BankStatementValidationError();
    const input = form.get("input"), file = form.get("file");
    if (typeof input !== "string" || input.length > 8192 || !(file instanceof File) || file.size < 1 || file.size > 10 * 1024 * 1024) throw new BankStatementValidationError();
    return { input: JSON.parse(input) as unknown, bytes: new Uint8Array(await file.arrayBuffer()) };
  } catch { throw new BankStatementValidationError(); }
}
