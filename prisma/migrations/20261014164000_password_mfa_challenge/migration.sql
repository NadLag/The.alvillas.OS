-- Expand the existing challenge type constraint without changing existing rows.
ALTER TABLE auth_challenge
  DROP CONSTRAINT auth_challenge_type_check,
  ADD CONSTRAINT auth_challenge_type_check CHECK (
    type IN ('PASSKEY_REGISTRATION', 'PASSKEY_AUTHENTICATION', 'PASSWORD_MFA')
  );
