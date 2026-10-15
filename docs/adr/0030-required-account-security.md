# ADR 0030 — Required account security enrollment

Date: 2026-10-14

Feature IDs: F-IDN-02, F-IDN-03, F-IDN-06, F-IDN-07, F-IDN-08, F-IDN-09

Required roles previously received business permissions before their first
authenticator was enrolled. Password verification must not grant those
permissions while the required factors are incomplete.

Use the existing role catalog and authenticated own-factor grant. Accounts
with incomplete required setup receive no business grants and are directed to
their existing security panel. Required roles cannot use field PIN login.
The existing password, passkey, TOTP and recovery authentication paths remain
in use. An enrolled account always retains its MFA requirement, including when
its factors are later revoked.

Only confirmed TOTP and MFA recovery credentials satisfy the second factor.
Pending TOTP secrets and expiring password-reset codes do not. First TOTP
confirmation invalidates earlier sessions so first-factor sessions cannot gain
business access after setup. Confirmation is serialized and audited.

PostgreSQL acceptance uses real password verification, WebAuthn registration
and signed assertions plus TOTP. Playwright enrolls factors through the actual
security panel and respects the real login rate window. Staging uses the
owner's existing authenticator and physically registered passkey.

No migration, credential reset or separate authentication system is required.
