import { z } from "zod";
import { PersonalDocumentRepository } from "../infrastructure/personal-document-repository";
import { HouseholdRepository, PersonalAccessDenied, personalIdentity, personalSession } from "./personal-session";

const identifiers = z.object({ householdId: z.uuid(), documentId: z.uuid() });

export async function personalDownload(raw: unknown) {
  const ids = identifiers.safeParse(raw);
  if (!ids.success) return null;
  const identity = personalIdentity(await personalSession());
  if (!identity) return null;
  try {
    return await new HouseholdRepository().scoped(identity, ids.data.householdId, (scope) =>
      new PersonalDocumentRepository(scope).download(ids.data.documentId));
  } catch (error) {
    if (error instanceof PersonalAccessDenied) return null;
    throw error;
  }
}

export { PersonalDocumentRepository };
