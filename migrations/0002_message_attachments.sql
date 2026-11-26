-- MailGate: lightweight attachment metadata (filename, MIME type, byte size).
-- Only a small JSON summary is stored; attachment binaries are never persisted in D1.

ALTER TABLE messages ADD COLUMN attachments_json TEXT DEFAULT NULL;
