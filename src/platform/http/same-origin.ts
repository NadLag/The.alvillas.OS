/** Host retains the browser's authority when Next normalizes the internal URL. */
export function isSameOriginContentType(request: Request, contentType: string): boolean {
  const url = new URL(request.url), expectedOrigin = `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  return request.headers.get("origin") === expectedOrigin &&
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === contentType;
}
