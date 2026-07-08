-- Durably record the IP each user registered from (staff-visible only).
ALTER TABLE users ADD COLUMN registration_ip inet NULL;
