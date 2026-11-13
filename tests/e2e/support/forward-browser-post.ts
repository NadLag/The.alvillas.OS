import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Page, Request } from "@playwright/test";

/** Forward the observed browser command once on a dedicated socket, then wait for its complete acknowledgement. */
export async function forwardBrowserPostOnce(request: Pick<Request, "url" | "method" | "allHeaders" | "postDataBuffer">, onBody?: (body: Buffer, headers: Readonly<IncomingHttpHeaders>) => void): Promise<number> {
  const target = new URL(request.url());
  if (request.method() !== "POST" || !["http:", "https:"].includes(target.protocol)) throw new Error("Observed HTTP browser POST required");
  const headers = await request.allHeaders(), send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(target, { method: "POST", headers: { ...headers, connection: "close" }, agent: false, signal: AbortSignal.timeout(30000) }, response => {
      const chunks: Buffer[] = [];
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Observed command acknowledgement ended before its body completed")));
      response.on("end", () => { try { onBody?.(Buffer.concat(chunks), response.headers); resolve(response.statusCode ?? 0); } catch (error) { reject(error instanceof Error ? error : new Error("Observed acknowledgement body could not be retained")); } });
      if (onBody) response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      else response.resume();
    });
    outgoing.on("error", reject); outgoing.end(request.postDataBuffer() ?? undefined);
  });
}

/** Use the authenticated browser cookies once; an unknown POST outcome is never retried. */
export async function postBrowserJsonOnce(page: Pick<Page, "context" | "evaluate">, path: string, options: { headers: Record<string,string> & { origin: string }; data: unknown; targetOrigin?: string }) {
  const origin = new URL(options.targetOrigin ?? options.headers.origin), target = new URL(path, origin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !['http:', 'https:'].includes(origin.protocol) || target.origin !== origin.origin)
    throw new Error("Same-origin owned browser POST required");
  const serialized = JSON.stringify(options.data);
  if (typeof serialized !== "string") throw new Error("Owned JSON command required");
  const cookies = await page.context().cookies(target.href), userAgent = await page.evaluate(() => navigator.userAgent), bytes = Buffer.from(serialized);
  let body: Buffer = Buffer.alloc(0), responseHeaders: Readonly<IncomingHttpHeaders> = {};
  const status = await forwardBrowserPostOnce({ url: () => target.href, method: () => "POST", allHeaders: () => Promise.resolve({ ...options.headers, "content-type": "application/json", "content-length": String(bytes.length), "user-agent": userAgent,
    cookie: cookies.map(cookie => cookie.name + "=" + cookie.value).join("; ") }), postDataBuffer: () => bytes }, (value, headers) => { body = value; responseHeaders = headers; });
  return { status: () => status, headers: () => ({ ...responseHeaders }), body: () => Promise.resolve(Buffer.from(body)), text: () => Promise.resolve(body.toString("utf8")), json: (): Promise<unknown> => Promise.resolve(JSON.parse(body.toString("utf8")) as unknown) };
}
