ALTER TABLE likes
  ADD COLUMN device_id_hash_version smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT likes_device_id_hash_required_check
    CHECK (device_id_hash_version = 1) NOT VALID,
  ADD CONSTRAINT likes_device_id_hash_format_check
    CHECK (device_id ~ '^[a-f0-9]{64}$') NOT VALID;

ALTER TABLE reports
  ADD COLUMN device_id_hash_version smallint NOT NULL DEFAULT 0,
  ADD CONSTRAINT reports_device_id_hash_required_check
    CHECK (device_id_hash_version = 1) NOT VALID,
  ADD CONSTRAINT reports_device_id_hash_format_check
    CHECK (device_id ~ '^[a-f0-9]{64}$') NOT VALID;
