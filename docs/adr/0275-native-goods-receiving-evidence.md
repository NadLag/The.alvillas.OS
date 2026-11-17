# ADR 0275 — Goods receiving against original accounting evidence

Status: Accepted

F-INV-07 records received quantities through the original inventory movement writer. Receiving does not create an expense, supplier/employee payment, journal, financial allocation or inventory valuation. Invoice monetary values remain in their existing accounting engine; physical quantities retain the catalog's immutable counting units.

An original posted expense family or recognized supplier-invoice line anchors a receiving command. Its receipt must retain the original document/archive ancestry and bytes digest. Where an expense already has original purchasing evidence, a financial-attachment alternative must match that original receipt digest. Current and held native financial, purchasing, archive and inventory source rights remain independent.

The existing outbox stores paired immutable command/source receipts. Its unique original-source key prevents receiving an expense family or recognized invoice line twice under different command nonces. Each batch binds the exact native purchase movement groups. A matched nonce recovers the original effect; an unrecorded nonce is closed against delayed publication. Delivery metadata can change without rewriting source evidence.

Publication locks the original accounting source and takes catalog, location and stock-stream locks in the same sorted phases as field operations. All movement groups and source/operational audits commit atomically. Final checks cover every original operational source and the financial evidence. An accounting reversal does not silently rewrite already observed physical stock; existing append-only movement reversal controls govern physical corrections.

General operational audit payloads contain receiving/movement references. The separate source-link audit uses the original protected financial transaction resource. Original financial facts stay in the private source receipt rather than a broad operational audit payload.

Additive migrations 296–299 validate the original accounting/receipt ancestry, paired receipts, exact native movement amounts and atomic audits. Forward corrections qualify SQL JSON entry/leg identifiers and retain the native Financial Attachment/admission shared identity; applied migration history is retained.
