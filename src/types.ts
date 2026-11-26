export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  MAIL_DOMAIN: string;
  STRICT_ALLOWLIST: string;
  RETENTION_DAYS: string;
  ALLOW_SIMULATE: string;
  ADMIN_EMAIL?: string;
  ADMIN_TOKEN?: string;
  SESSION_SECRET?: string;
}

export interface AllowedInboxRow {
  id: number;
  email_address: string;
  label: string;
  password_hash: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  recipient_email: string;
  sender: string;
  sender_name: string;
  subject: string;
  body_text: string;
  body_html: string;
  otp_code: string | null;
  is_read: number;
  received_at: string;
  attachments_json?: string | null;
}

export interface AttachmentSummary {
  filename: string | null;
  mimeType: string;
  size: number;
}

export interface MessageSummary {
  id: string;
  recipient_email: string;
  sender: string;
  sender_name: string;
  subject: string;
  preview: string;
  otp_code: string | null;
  is_read: boolean;
  received_at: string;
}
