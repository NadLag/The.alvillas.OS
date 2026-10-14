# F-IDN-03/06/09: staged login and server-only rate-limit context

Email/password and phone/PIN have separate form states. A valid password for an MFA account issues a five-minute challenge using the existing encrypted-secret envelope and AuthChallenge table. It binds the account, organization, email, device and session version; no password is sent back to the browser. The second factor is verified before the challenge is atomically consumed and Auth.js creates the existing audited session. Recovery credentials are also consumed atomically. Revoking credentials or sessions invalidates outstanding challenges through sessionVersion.

The server action checks the existing PostgreSQL limiter before authentication. AsyncLocalStorage carries that check to Auth.js for the same account and IP, avoiding double counting. HTTP credentials cannot supply this context; the previous browser-supplied rateLimitChecked flag is removed. Direct Auth.js requests always use the limiter.

Acceptance requires local and CI PostgreSQL/browser tests plus deployed staging verification. Provider-backed password-reset delivery retains its existing credential blocker.

The forward migration expands the existing challenge type constraint to admit PASSWORD_MFA. It leaves existing rows and passkey challenge types intact; production application is outside this change's deployment authorization.
