import {randomUUID} from "node:crypto";
import {afterEach,describe,it,expect,vi} from "vitest";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {GuestHubNativeSource} from "@/modules/guest-hub/infrastructure/guest-hub-repository";
import type {guestHubAgreementTemplate} from "@/modules/guest-hub/domain/guest-hub-agreement-policy";
import {GuestHubAgreementAccessError} from "@/modules/guest-hub/domain/guest-hub-agreement-policy";
import * as documents from "@/modules/documents/application/document-prepared-signature-authority";
import {nativeGuestAgreementDocumentAuthority} from "@/app/api/guest-hub/agreement/native-document-authority";
afterEach(()=>vi.restoreAllMocks());
describe("authorized prepared guest agreement pagination",()=>{
 it("does not expose a continuation hint when every original in multiple raw pages is hidden",async()=>{
  const organizationId=randomUUID(),actor={organizationId,actorId:randomUUID(),authContext:{organizationId,permissions:new Set<string>(),scopes:[]}},source={reservationId:randomUUID()}as GuestHubNativeSource,selection:ReturnType<typeof guestHubAgreementTemplate>={requestedLocale:"fr",locale:"fr",templateKey:"owned_guest_agreement",templateVersionId:randomUUID(),variantVersionIds:[randomUUID(),randomUUID()],documentTypeKey:"owned_guest_agreement"},candidate=()=>({preparationId:randomUUID(),preparedAt:"2026-11-15T12:00:00.000Z"});
  const page=vi.spyOn(documents,"preparedSignatureCandidatePage").mockResolvedValueOnce({items:Array.from({length:25},candidate),next:"opaque-raw-page"}).mockResolvedValueOnce({items:[candidate()],next:null}),cursor=vi.spyOn(documents,"preparedSignatureChoiceCursor"),capture=vi.spyOn(nativeGuestAgreementDocumentAuthority,"capture").mockRejectedValue(new GuestHubAgreementAccessError());
  expect(await nativeGuestAgreementDocumentAuthority.choices(actor,{}as TenantTransaction,source,selection,"a".repeat(64))).toEqual({items:[],next:null});expect(page).toHaveBeenCalledTimes(2);expect(capture).toHaveBeenCalledTimes(26);expect(cursor).not.toHaveBeenCalled();
 });
});
