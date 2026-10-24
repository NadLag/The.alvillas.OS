# ADR 0055: Field PIN entry and enrollment routing

Date: 2026-10-23

Status: Accepted

The field sign-in surface reuses the existing invitation, credential verifier, persistent PIN backoff, session creation, authorization and audit services. It adds a masked input and a keyboard-accessible keypad with large touch targets. PIN entry stays in component memory, clears after rejected authentication or a method change, and never enters the offline cache. Arabic and Persian numeral forms normalize to the same decimal digits; invalid characters remain invalid for the existing verifier.

The `surface=field` flag selects the initial Phone + PIN view and a constant field landing route after successful authentication. It supplies no permission and accepts no arbitrary redirect URL. Password and passkey flows retain their existing MFA requirements. Valid sessions that still require security enrollment reach the security page before field list/detail access. The current authorization context continues to withhold permissions until required enrollment is complete.

Authenticated local browser acceptance uses native invitations and phone-only activation. It checks rejected PIN handling, pending controls, keyboard input, masking, account scope, forged ownership denial and enrollment redirects. Staging acceptance needs the owner to identify a suitable existing real field account; no synthetic staging account or owner credential reset is used. F-FLD-02 stays IN-PROGRESS until that acceptance is complete.
