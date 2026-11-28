import { requirePrivatePayloadKeys } from "@/platform/auth/private-payload-keys";
import { decryptBytes, encryptBytes } from "@/platform/auth/secret-encryption";
import { guestHubPropertyInformationSchema, guestHubStoredPropertyInformationSchema } from "./guest-hub-property-information";

function propertyInformationContext(organizationId: string, propertyId: string): string {
  return `alvillas.guest-hub.property-information.v1:${organizationId}:${propertyId}`;
}

function keysUnavailable(): Error {
  return new Error("Private Guest Hub property information keys are unavailable");
}

export function protectGuestHubPropertyInformation(raw: unknown, organizationId: string, propertyId: string, env = process.env) {
  const information = guestHubPropertyInformationSchema.parse(raw);
  requirePrivatePayloadKeys(env, true, keysUnavailable);
  const plain = Buffer.from(JSON.stringify(information), "utf8");
  try {
    const encrypted = encryptBytes(plain, propertyInformationContext(organizationId, propertyId), env);
    return { encrypted: encrypted.toString("base64url") };
  } finally {
    plain.fill(0);
  }
}

export function readGuestHubPropertyInformation(raw: unknown, organizationId: string, propertyId: string, env = process.env) {
  const { encrypted } = guestHubStoredPropertyInformationSchema.parse(raw);
  requirePrivatePayloadKeys(env, false, keysUnavailable);
  const plain = decryptBytes(Buffer.from(encrypted, "base64url"), propertyInformationContext(organizationId, propertyId), env);
  try {
    return guestHubPropertyInformationSchema.parse(JSON.parse(plain.toString("utf8")));
  } finally {
    plain.fill(0);
  }
}
