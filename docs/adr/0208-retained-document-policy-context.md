# ADR0208: Retained version tags and native policy context

F-DOC-10 records descriptive retention tags against actual immutable document
versions. Every change, correction and cleared selection appends its original
actor command, source facts, authorization and configured tag snapshots. Earlier
labels, holds and policy references remain readable after configuration changes.
Original document bodies, signed artifacts and financial rows remain unchanged.

Signed PDFs and certificates inherit governance from their original signed source
version. Their system-owned archive records are not editable metadata targets.
Tagging archived originals is an explicit configuration choice. Current and held
document, source, template, counterparty and financial authorization continue to
come from the shared archive context; tags do not grant data access.

The native policy-context read is an authorized, audited input for the privacy
workflow. It identifies the original version and retained state and reports actual
hold descriptors and entered policy references. A reference or a cleared tag set
does not approve disposal. This feature provides no deletion or financial rewrite
command. The owner-approved retention/privacy policy and the legal decisions in
handbook Part L remain requirements of the privacy workflow and hosted acceptance.

The implementation reuses document repositories, private HTTP, configurable
admission, captured authorization, audit and actor nonce recovery. The selected
set is canonicalized, while every business tag and policy reference is configured.
No retention period, tax interpretation or legal approval is supplied implicitly.
