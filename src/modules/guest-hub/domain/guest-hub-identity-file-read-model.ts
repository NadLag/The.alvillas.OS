import {z} from "zod";
import {guestHubIdSchema} from "./guest-hub-contract";
import {guestHubIdentityDocumentKindSchema,guestHubIdentityDocumentPartSchema} from "./guest-hub-identity-document-policy";

/** Only actual publication facts are acknowledged; private archive identifiers,
 * original hashes, storage keys and download authority stay on the server. */
export const guestHubIdentityFileStatusSchema=z.object({
 captureId:guestHubIdSchema,fileId:guestHubIdSchema,kind:guestHubIdentityDocumentKindSchema,part:guestHubIdentityDocumentPartSchema,
 state:z.enum(["PENDING","ADMITTED","PUBLISHED"]),currentCapture:z.boolean(),publishedAt:z.iso.datetime().nullable()
}).strict().refine(value=>(value.state==="PUBLISHED")===(value.publishedAt!==null));
