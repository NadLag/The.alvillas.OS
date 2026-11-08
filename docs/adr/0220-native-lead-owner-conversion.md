# ADR 0220: Native Lead to Owner conversion

Conversion retains one immutable tenant-bound receipt per Lead. It requires the
actual native Signed stage and its completed signed archive. An approved
organization rule enables explicit creation or linking; no source string,
caller-supplied signature flag or email match grants conversion authority.

Creation reuses the Core Owner service and its authoritative input validation.
The reviewed latest captured contact, phone, email and locale supply those
fields without re-entry. Missing or incompatible source values require an
explicit Lead profile correction; values are never truncated or invented.
Linking requires explicit independent authority over the existing Owner and
does not overwrite that Owner. Acquisition notes, referral identities,
financial settings and payout instructions are not copied to Owner fields.
The original Lead and every correction remain available through their native
authorized history.

The receipt binds the source profile, Signed revision, original native archive,
current configuration, actor and nonce. Its private command, reason and
original Owner identity use the existing authenticated encryption and retained
keyring. Identifier-only canonical audit and outbox records commit with the
Owner and conversion. A lost response recovers the original receipt, including
after subsequent authorized Owner changes, without creating another Owner or
replaying financial or provider effects.

Held and current Lead view, export and edit permissions and independent Owner
permissions apply before decryption and again after audit. Review does not
move a pipeline stage, activate a property, grant portal access or release an
onboarding workflow. The later explicit Onboarding stage consumes the actual
conversion receipt; Go Live remains closed until its native release producer
is implemented and qualified. Local implementation and tests do not establish
legal, hosted provider, staging or production acceptance.
