-- Expand accepted event kinds without changing any existing notification history.
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check
  CHECK (kind IN ('language_updated', 'task_assigned', 'security_session_revoked', 'reservation_created', 'task_completed'));
