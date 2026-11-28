import { z } from "zod";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository, type ConfigScopeCandidate } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { guestHubCheckInPolicyKey, guestHubCheckInPolicySchema, type GuestHubCheckInReadiness,
  type GuestHubCheckInRequirement } from "@/platform/config/guest-hub-check-in-policy";
import { decryptGuestHubProfile } from "../domain/guest-hub-profile-payload";
import { effectiveGuestHubProfilePolicy, guestHubProfilePolicySchema, GuestHubProfileAccessError, GuestHubProfileConfigurationError,
  presentGuestHubProfileValues, validateGuestHubProfileValues } from "../domain/guest-hub-profile-policy";
import { decryptGuestHubStayDetails } from "../domain/guest-hub-stay-details-private";
import { presentGuestHubStayDetails, resolveGuestHubStayDetails } from "../domain/guest-hub-stay-details-time";
import { effectiveGuestHubStayDetailsPolicy, guestHubStayDetailsPolicySchema, GuestHubStayDetailsAccessError, GuestHubStayDetailsConfigurationError,
  GuestHubStayDetailsValidationError } from "../domain/guest-hub-stay-details-policy";
import { approvedGuestHubHouseRulesSource } from "../domain/guest-hub-house-rules-source";
import { decryptGuestHubHouseRules } from "../domain/guest-hub-house-rules-private";
import { effectiveGuestHubHouseRulesPolicy, GuestHubHouseRulesAccessError, GuestHubHouseRulesConfigurationError } from "../domain/guest-hub-house-rules-policy";
import { decryptGuestHubIdentityDocumentCapture } from "../domain/guest-hub-identity-document-private";
import { guestHubIdentityDocumentManifestSchema } from "../domain/guest-hub-identity-document-private-contract";
import { effectiveGuestHubIdentityDocumentPolicy, guestHubIdentityDocumentPolicySchema, GuestHubIdentityDocumentAccessError,
  GuestHubIdentityDocumentConfigurationError } from "../domain/guest-hub-identity-document-policy";
import { effectiveGuestHubAgreementPolicy, guestHubAgreementPolicySchema, GuestHubAgreementAccessError,
  GuestHubAgreementConfigurationError } from "../domain/guest-hub-agreement-policy";
import { GuestHubRepository, type GuestHubNativeSource } from "../infrastructure/guest-hub-repository";
import { GuestHubProfileRepository } from "../infrastructure/guest-hub-profile-repository";
import { GuestHubStayDetailsRepository } from "../infrastructure/guest-hub-stay-details-repository";
import { GuestHubHouseRulesRepository } from "../infrastructure/guest-hub-house-rules-repository";
import { GuestHubIdentityCaptureRepository } from "../infrastructure/guest-hub-identity-capture-repository";
import { GuestHubIdentityArchiveRepository } from "../infrastructure/guest-hub-identity-archive-repository";
import { GuestHubAgreementRepository } from "../infrastructure/guest-hub-agreement-repository";
import { guestHubProfileRevisionBinding, guestHubProfileSettings } from "./guest-hub-profile-source";
import { guestHubStayDetailsRevisionBinding, guestHubStayDetailsSettings } from "./guest-hub-stay-details-source";
import { guestHubHouseRulesAcceptanceBinding, guestHubHouseRulesSettings } from "./guest-hub-house-rules-source";
import { guestHubIdentityCaptureBinding } from "./guest-hub-identity-capture-source";
import { guestHubIdentityDocumentSettings } from "./guest-hub-identity-document-grants";
import { authenticateGuestHubAgreementRelease, guestHubAgreementSettings } from "./guest-hub-agreement-source";

type Stay = { reservationId: string; propertyId: string; bookingSource: string };
const sourcePolicy = z.object({ value: z.unknown() }).passthrough();
const incompleteEvidence = [
  z.ZodError, GuestHubProfileAccessError, GuestHubProfileConfigurationError,
  GuestHubStayDetailsAccessError, GuestHubStayDetailsConfigurationError, GuestHubStayDetailsValidationError,
  GuestHubHouseRulesAccessError, GuestHubHouseRulesConfigurationError,
  GuestHubIdentityDocumentAccessError, GuestHubIdentityDocumentConfigurationError,
  GuestHubAgreementAccessError, GuestHubAgreementConfigurationError
];

async function readEvidence<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (incompleteEvidence.some(Type => error instanceof Type)) return null;
    throw error;
  }
}

function formEvidence(tx: TenantTransaction, organizationId: string, source: GuestHubNativeSource, now: Date, env: NodeJS.ProcessEnv) {
  const { reservationId, guestId, propertyId } = source;
  async function profile() {
    const revision = await new GuestHubProfileRepository(tx, organizationId).latestRevision(reservationId, guestId);
    if (revision?.propertyId !== propertyId) return false;
    const { policy } = await guestHubProfileSettings(tx, organizationId, source, now);
    const payload = decryptGuestHubProfile(revision.encryptedPayload, guestHubProfileRevisionBinding(revision), env);
    const original = guestHubProfilePolicySchema.parse(sourcePolicy.parse(revision.policySnapshot).value);
    const effective = effectiveGuestHubProfilePolicy(original, policy);
    validateGuestHubProfileValues(presentGuestHubProfileValues({}, payload.values, effective.allowed), effective, payload.acknowledged);
    return true;
  }

  async function stayDetails() {
    const revision = await new GuestHubStayDetailsRepository(tx, organizationId).latestRevision(reservationId, guestId);
    if (revision?.propertyId !== propertyId) return null;
    const { policy } = await guestHubStayDetailsSettings(tx, organizationId, source, now);
    const payload = decryptGuestHubStayDetails(revision.encryptedPayload, guestHubStayDetailsRevisionBinding(revision), env);
    const calendar = { checkIn: source.checkIn.toISOString().slice(0, 10), checkOut: source.checkOut.toISOString().slice(0, 10), timezone: source.timezone };
    const original = guestHubStayDetailsPolicySchema.parse(sourcePolicy.parse(revision.policySnapshot).value);
    const effective = effectiveGuestHubStayDetailsPolicy(original, policy);
    const current = resolveGuestHubStayDetails(presentGuestHubStayDetails(payload.values, effective), calendar, effective, payload.acknowledged);
    return {
      arrival: Boolean(current.resolved.arrival && current.resolved.arrival === payload.resolved.arrival),
      departure: Boolean(current.resolved.departure && current.resolved.departure === payload.resolved.departure)
    };
  }

  async function houseRules() {
    const repository = new GuestHubHouseRulesRepository(tx, organizationId);
    const original = await repository.canonicalRules(propertyId);
    if (!original) return false;
    const { policy } = await guestHubHouseRulesSettings(tx, organizationId, source, now);
    const approved = approvedGuestHubHouseRulesSource(effectiveGuestHubHouseRulesPolicy(policy, policy), organizationId, propertyId, original.rules);
    const acceptance = await repository.acceptanceForEdition(reservationId, guestId, approved.editionFingerprint);
    if (acceptance?.propertyId !== propertyId) return false;
    return decryptGuestHubHouseRules(acceptance.encryptedPayload, guestHubHouseRulesAcceptanceBinding(acceptance), env).acknowledged;
  }

  async function identityDocuments() {
    const capture = await new GuestHubIdentityCaptureRepository(tx, organizationId).latestCapture(reservationId, guestId);
    if (capture?.propertyId !== propertyId) return false;
    const { policy } = await guestHubIdentityDocumentSettings(tx, organizationId, source, now);
    const original = guestHubIdentityDocumentPolicySchema.parse(sourcePolicy.parse(capture.policySnapshot).value);
    const active = effectiveGuestHubIdentityDocumentPolicy(original, policy);
    const manifest = guestHubIdentityDocumentManifestSchema.parse(capture.fileManifest);
    const payload = decryptGuestHubIdentityDocumentCapture(capture.encryptedPayload, guestHubIdentityCaptureBinding(capture), manifest, env);
    if (active.requireAcknowledgement && !payload.acknowledged) return false;
    if (!payload.files.every(file => active.contentTypes.includes(file.contentType) && file.fileSize <= active.maxDocumentBytes &&
      active.documents.some(document => document.kind === file.kind && document.allowedParts.includes(file.part)))) return false;
    if (!active.requiredKinds.every(kind => manifest.some(file => file.kind === kind))) return false;
    if (!active.documents.every(document => !manifest.some(file => file.kind === document.kind) ||
      document.requiredParts.every(part => manifest.some(file => file.kind === document.kind && file.part === part)))) return false;
    const files = await new GuestHubIdentityArchiveRepository(tx, organizationId).publishedCaptureFiles(capture.id);
    const published = new Set(files.map(file => file.fileId));
    return manifest.every(file => published.has(file.id));
  }

  async function signedAgreement() {
    const repository = new GuestHubAgreementRepository(tx, organizationId);
    const release = await repository.releaseForStay(reservationId, propertyId, guestId);
    if (release?.decision !== "GRANTED") return false;
    authenticateGuestHubAgreementRelease(release, env);
    const { policy } = await guestHubAgreementSettings(tx, organizationId, source, now);
    effectiveGuestHubAgreementPolicy(guestHubAgreementPolicySchema.parse(sourcePolicy.parse(release.policySnapshot).value), policy);
    return Boolean(await repository.signedRequestForRelease(release.id));
  }

  return { profile, stayDetails, houseRules, identityDocuments, signedAgreement };
}

/** Accept only completed evidence owned by the actual original stay and guest. */
export async function readGuestHubCheckIn(tx: TenantTransaction, organizationId: string, stay: Stay, now: Date,
  env: NodeJS.ProcessEnv = process.env, verified?: { source: GuestHubNativeSource; scopes: ConfigScopeCandidate[] }): Promise<GuestHubCheckInReadiness | null> {
  const scopes = verified?.scopes ?? await new ReservationConfigScopeRepository(tx, organizationId).scopes({
    propertyId: stay.propertyId, source: stay.bookingSource, asOf: now
  });
  const rule = await new ConfigRuleRepository(tx, organizationId).resolve({ key: guestHubCheckInPolicyKey, scopes, asOf: now });
  if (!rule?.createdBy || rule.lifecycle !== "ACTIVE") return null;
  const policy = guestHubCheckInPolicySchema.parse(rule.parsedValue);
  if (!policy.enabled) return null;
  const source = verified?.source ?? await new GuestHubRepository(tx, organizationId).source(stay.reservationId);
  if (!source?.sourceAvailable || source.reservationId !== stay.reservationId || source.propertyId !== stay.propertyId || source.bookingSource !== stay.bookingSource) {
    return { ready: false, requirements: policy.required_forms.map(form => ({ form, complete: false })) };
  }
  const evidence = formEvidence(tx, organizationId, source, now, env);
  let details: Awaited<ReturnType<typeof evidence.stayDetails>> | undefined;
  const readDetails = async () => {
    if (details === undefined) details = await readEvidence(evidence.stayDetails);
    return details;
  };
  const reads: Record<GuestHubCheckInRequirement, () => Promise<boolean>> = {
    PROFILE: evidence.profile,
    ARRIVAL_DETAILS: async () => Boolean((await readDetails())?.arrival),
    DEPARTURE_DETAILS: async () => Boolean((await readDetails())?.departure),
    HOUSE_RULES: evidence.houseRules,
    IDENTITY_DOCUMENTS: evidence.identityDocuments,
    SIGNED_AGREEMENT: evidence.signedAgreement
  };
  const requirements: GuestHubCheckInReadiness["requirements"] = [];
  for (const form of policy.required_forms) {
    requirements.push({ form, complete: (await readEvidence(reads[form])) === true });
  }
  return { ready: requirements.every(requirement => requirement.complete), requirements };
}
