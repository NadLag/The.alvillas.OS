# Encryption key rotation

F-SEC-06 applies separately to `ENCRYPTION_KEYS` and `PERSONAL_ENCRYPTION_KEYS`. Each ring contains ordered version and key pairs. The first pair is used for new ciphertext or evidence signatures and retained versions remain available for historical reads. Keep the rings in the environment's secret store and keep the retained versions with controlled recovery material.

1. Identify the ring, current version, affected environments and backups. Create a fresh cryptographically random 32-byte key with a new version identifier in the secret store.
2. In isolated staging, put the new pair first and retain the prior pairs in their existing order. Deploy the same configuration to API and worker runtimes.
3. Verify a previously sealed artifact can be read or verified, a new artifact uses the new version, and the restore operator can recover both versions. For Personal OS, download both documents using a currently authorized household session.
4. Promote after owner approval using the verified release process. If the new version must stop being used for writes, put the previous pair first and keep the newer pair available for artifacts written since the cutover.
5. Retire a version only after the relevant retention and backup windows have closed and recovery evidence confirms the version is unused. Keep immutable financial and audit history intact.

`AUTH_SECRET` is also the legacy fallback in environments that used it before setting an explicit ring. Before rotating it, identify any fallback-encrypted artifacts and preserve their decryption material in the approved ring. Session rotation requires a planned reauthentication window. An exposed key follows the incident process and the owner-approved data-retention decision.
