/** Bound untrusted object responses before allocating the complete image. */
export async function readExactResponseBytes(response: Response, expectedBytes: number): Promise<Uint8Array> {
  return readBytes(response, expectedBytes, true);
}

export async function readBoundedJsonRequest(request: Request, maximumBytes: number): Promise<unknown> {
  const bytes = await readBytes(request, maximumBytes, false);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

export async function readBoundedRequestBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  return readBytes(request, maximumBytes, false);
}

async function readBytes(response: Pick<Response, "headers" | "body">, expectedBytes: number, exact: boolean): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !response.body) throw new Error("response_size_invalid");
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > expectedBytes) {
    await response.body.cancel().catch(() => undefined); throw new Error("response_size_invalid");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > expectedBytes) throw new Error("response_size_invalid");
      chunks.push(next.value);
    }
    if (exact && size !== expectedBytes) throw new Error("response_size_invalid");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch {
    await reader.cancel().catch(() => undefined); throw new Error("response_size_invalid");
  } finally { reader.releaseLock(); }
}
