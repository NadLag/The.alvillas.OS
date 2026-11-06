# 0197 — Immutable generation intents within one logical document

F-DOC-04. Scope unchanged: all 355 approved features remain required.

Keep `Document` as the logical archive record and add another immutable `DocumentInstance` for each generated amendment. Each intent retains its own reviewed native template versions, source values, captured authority, command nonce, encrypted input and first chosen PDF. Reuse the existing `DocumentVersion` supersession chain and the admission's authenticated `generationInstanceId`; another intent table, copied financial source or rewritten original is unnecessary.

An amendment names the actual latest immutable predecessor. It must retain the logical source, type, language and native template-key family. It requires current and held document edit, generation creation, source export and original-template authority. Any necessary privacy strengthening retains the existing classes and has atomic private before/after history and canonical audit. Capture the resulting document revision in the intent; pending publication fails closed on subsequent source, policy, protection or predecessor changes.

Recovery selects the admission and version belonging to that intent's actual actor/nonce, rather than the logical document's latest version. Older successful nonces continue to return their original version after an amendment. Preserve the exact legacy command hash by adding optional amendment fields without defaults; retain original ciphertext, snapshots, source rows and tuple versions. Provider and object I/O remain outside transactions, with one conditional chosen ciphertext and authorization checks after every boundary.

Migration193 replaces the instance/document uniqueness index with an ordered tenant/document index and strengthens the native generation, predecessor, payload, audit and signature-reference guards. It adds no business table or column and performs no business-row DML. All192 predecessor migrations remain frozen. The repository retains a selected-instance view while the native relation supports multiple immutable intents.

A signature remains attached to its original instance and original version. Native guards prevent another amendment's PDF from being substituted under that signature. The signature/archive integration must also keep a returned signed representation from selecting an older business intent over a newer amendment. No signature outcome, financial movement or legal clause is invented by generation. Full hosted acceptance remains required before DONE.
