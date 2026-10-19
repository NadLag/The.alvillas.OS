ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK(kind IN ('language_updated','task_assigned','task_completed','task_overdue','reservation_created','security_session_revoked','approval_requested','approval_decided','staff_document_expiring'));
