import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b)));
  }
  // Global unicast only. IPv4-mapped, loopback, link-local and ULA are excluded.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/iu.test(address) && !/^2001:(?:db8|0):/iu.test(address);
}
export function feedUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash || /(?:^localhost$|\.localhost$|\.local$|\.internal$)/iu.test(hostname) || (isIP(hostname) && !publicAddress(hostname))) throw new Error("invalid_feed_url");
  return url;
}
export type FeedResponse = { status: number; content: string; etag: string | null; lastModified: string | null };
export type FeedTransport = (url: string, conditional: { etag: string | null; lastModified: string | null }) => Promise<FeedResponse>;

/** Resolve once and pin the public address for the TLS request; redirects never follow. */
export const fetchIcalFeed: FeedTransport = async (value, conditional) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("feed_timeout")); }, 15000);
  });
  const perform = async () => {
    const url = feedUrl(value);
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/gu, ""), { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error("invalid_feed_address");
    return await new Promise<FeedResponse>((resolve, reject) => {
      const req = request(url, {
        signal: controller.signal,
        method: "GET", headers: { Accept: "text/calendar", "Accept-Encoding": "identity", ...(conditional.etag ? { "If-None-Match": conditional.etag } : {}), ...(conditional.lastModified ? { "If-Modified-Since": conditional.lastModified } : {}) },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }
      }, response => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) req.destroy(new Error("feed_too_large")); else chunks.push(chunk); });
        response.on("error", () => reject(new Error("feed_transport_failed")));
        response.on("end", () => resolve({ status: response.statusCode ?? 500, content: Buffer.concat(chunks).toString("utf8"), etag: String(response.headers.etag ?? "") || null, lastModified: String(response.headers["last-modified"] ?? "") || null }));
      });
      req.setTimeout(15000, () => req.destroy(new Error("feed_timeout")));
      req.on("error", () => reject(new Error("feed_transport_failed")));
      req.end();
    });
  };
  try { return await Promise.race([perform(), deadline]); }
  catch { throw new Error("feed_transport_failed"); }
  finally { if (timer) clearTimeout(timer); }
};
