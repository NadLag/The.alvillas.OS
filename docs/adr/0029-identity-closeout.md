# 0029 — Identity sign-in and lifecycle closeout

Passkey assertions feed the existing Auth.js credential/session core through an encrypted,
device-bound, expiring, single-use challenge. Required TOTP or recovery remains a second
step. Owners can enroll their own factors through an authenticated, account-scoped grant;
it grants no identity collection, role, or business access. WebAuthn requires user verification.

PIN authentication retains the shared IP limiter and adds an identifier-scoped failure streak
in the existing tenant-protected rate_limit_bucket. An advisory transaction lock serializes
verification and failures, across IPs and processes. The initial identity.pin_lockout config_rule
is persisted on first use and can be versioned through existing configuration administration.
Failures back off exponentially; locked requests do not extend the lock; success resets the
streak. A retired policy fails closed. Accounts requiring MFA cannot use PIN as an alternative.

Invitation and passkey consumption serialize before verification. Recovery consumes codes
conditionally, rejects offboarded accounts, and password credential revocation also clears
the legacy hash. Business history and the owner's enrolled staging factors are preserved.

Repeated first-admin bootstrap returns when the named account exists. Deployments cannot
rotate its credentials, reactivate it, rename its profile, or alter its assignments. Recovery
and lifecycle changes remain explicit authenticated operations.

Identity date labels are rendered on the server and serialized. Node and browser timezone
databases can disagree about Morocco's offset, so client reformatting must not break hydration.
