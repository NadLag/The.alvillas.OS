import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

export const deviceCookieName = "alvillas_device_id";

export function newDeviceId(): string {
  return randomBytes(18).toString("base64url");
}

export async function ensureDeviceId(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(deviceCookieName)?.value;

  if (existing && /^[a-zA-Z0-9_-]{20,}$/u.test(existing)) {
    return existing;
  }

  const deviceId = newDeviceId();
  cookieStore.set(deviceCookieName, deviceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365
  });

  return deviceId;
}
