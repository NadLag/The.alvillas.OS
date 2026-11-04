import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Request } from "@playwright/test";

/** Forward the observed browser command once on a dedicated socket, then wait for its complete acknowledgement. */
export async function forwardBrowserPostOnce(request: Pick<Request, "url" | "method" | "allHeaders" | "postDataBuffer">): Promise<number> {
  const target = new URL(request.url());
  if (request.method() !== "POST" || !["http:", "https:"].includes(target.protocol)) throw new Error("Observed HTTP browser POST required");
  const headers = await request.allHeaders(), send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = send(target, { method: "POST", headers: { ...headers, connection: "close" }, agent: false, signal: AbortSignal.timeout(30000) }, response => {
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Observed command acknowledgement ended before its body completed")));
      response.on("end", () => resolve(response.statusCode ?? 0));
      response.resume();
    });
    outgoing.on("error", reject); outgoing.end(request.postDataBuffer() ?? undefined);
  });
}
