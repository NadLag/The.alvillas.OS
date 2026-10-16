ALTER TABLE reservation ADD COLUMN guest_phone TEXT;
ALTER TABLE reservation ADD COLUMN guest_preferred_locale CHAR(2) NOT NULL DEFAULT 'fr';
ALTER TABLE reservation ADD CONSTRAINT reservation_guest_locale_check CHECK (guest_preferred_locale IN ('en', 'fr', 'ar'));
