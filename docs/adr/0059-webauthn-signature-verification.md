# ADR 0059: Maintained WebAuthn signature verification

Date: 2026-10-24

Status: Accepted

The complete PostgreSQL suite exposed a valid P-256 assertion rejected by SimpleWebAuthn 9.0.3. Its DER conversion does not left-pad a 31-byte ECDSA component to the required 32-byte component. Upstream [PR 594](https://github.com/MasterKale/SimpleWebAuthn/pull/594) fixes this error. A checked-in synthetic public protocol vector reproduces the failure deterministically; its private key was discarded. Tests never regenerate signatures until a verification succeeds.

Pin the server SDK to 14.0.3 and browser SDK to 14.0.0. Adapt the existing identity service to the public credential API and browser calls to `optionsJSON`; keep existing credential IDs, public-key bytes, counters, challenge consumption, origin/RP checks, required user verification, authorization, sessions, enrollment and audit. No credential or database migration is needed. The native verifier also rejects altered challenges, origins, RP IDs, absent user verification, tampered signatures and replayed counters.

Auth.js beta.32 still declares optional WebAuthn 9 peer dependencies. Scoped npm overrides resolve those optional peers to the same maintained SDK used by the application, so `npm ci` works without a global peer-resolution bypass. ALVILLAS OS configures only the Auth.js Credentials provider in `auth.ts`; passkey registration and verification run through the existing identity service, followed by the existing verified-login/MFA handoff. Auth.js's experimental WebAuthn provider is not configured and is not an integration boundary supported by this decision. Enabling it requires an explicit compatibility review.

The lockfile also advances the existing transitive `fast-uri` dependency to its patched release; the resolved dependency audit reports zero vulnerabilities. Validation must include a clean install, the real PostgreSQL identity/enrollment/concurrency tests and complete desktop/mobile browser suite. This change does not complete authenticated Phone + PIN staging acceptance for a real field account.
