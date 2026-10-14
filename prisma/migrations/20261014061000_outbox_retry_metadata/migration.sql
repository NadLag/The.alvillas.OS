ALTER TABLE outbox_event
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error text;

CREATE INDEX outbox_event_org_status_retry_idx
  ON outbox_event (organization_id, status, next_attempt_at, occurred_at);
