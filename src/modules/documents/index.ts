/** Public document contracts; native consumers reuse the canonical archive and retention schemas. */
export {documentUploadReviewInput} from "./domain/document-command";
export {documentUploadChunkBytes,documentSingleBodyBytes} from "./domain/document-upload-parts";
export {documentArchivePolicySchema} from "./domain/document-policy";
export {documentRetentionTagKey,documentRetentionPolicySchema} from "./domain/document-retention-policy";
