# Original bilingual owner email delivery

Owner delivery consumes a genuinely complete native owner package. It generates English and French email originals from the actual authorized owner/property configuration and selects the owner's configured communication language. Arabic requires an explicitly approved email policy and a distinct completed Arabic document. There is no language fallback or inferred recipient.

The existing EmailProvider gains an optional PDF attachment contract. Native delivery must read original archived versions through canonical authorization, verify their hashes and pass their bytes. Hosted attachment paths and storage URLs are not accepted. Attachments participate in the fallback idempotency fingerprint, while existing emails retain their exact request shape and key behavior.

[Resend's send-email contract](https://resend.com/docs/api-reference/emails/send-email) accepts attachment filename/content and documents a 40 MB limit after Base64 encoding. The adapter validates canonical Base64 PDF bytes, distinct safe names and the complete encoded request size before transport. This is a transport bound, not a business rule. Native admission, receipt history and provider restrictions remain required; composing an email or accepting a request cannot claim delivery.

The canonical email delivery service remains responsible for suppression, retry policy, stable provider keys and verified receipts. Onboarding will reference its actual delivery records rather than introducing another provider or retry implementation. External sending and hosted acceptance remain restricted.
