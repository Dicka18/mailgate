export interface MailGateClientOptions {
  baseUrl: string;
  adminToken?: string;
  fetch?: typeof globalThis.fetch;
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

export interface AttachmentSummary {
  filename: string | null;
  mimeType: string;
  /** Decoded attachment size in bytes. */
  size: number;
}

export interface FullMessage {
  id: string;
  recipient_email: string;
  sender: string;
  sender_name: string;
  subject: string;
  body_text: string;
  body_html: string;
  otp_code: string | null;
  verification_link: string | null;
  is_read: boolean;
  received_at: string;
  /** Attachment metadata only; binaries are never stored. Empty for messages without attachments. */
  attachments: AttachmentSummary[];
}

export interface LatestOtpResponse {
  ok: true;
  found: boolean;
  otpCode: string | null;
  verificationLink: string | null;
  message: {
    id: string;
    recipient_email: string;
    sender: string;
    sender_name: string;
    subject: string;
    received_at: string;
  } | null;
}

export interface InboxQueryOptions {
  email: string;
  password?: string;
  since?: Date | string | number;
  sender?: string;
}

export interface WaitForOtpOptions extends InboxQueryOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface WaitForEmailOptions extends WaitForOtpOptions {
  subjectIncludes?: string;
}

export class MailGateError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(message: string, status: number, code: string, details?: unknown);
}

export class MailGateTimeoutError extends Error {
  constructor(message: string);
}

export class MailGateClient {
  readonly baseUrl: string;
  readonly adminToken?: string;

  constructor(options: MailGateClientOptions);

  health(): Promise<{ ok: true; service: string; version: string; timestamp: string }>;
  checkInbox(email: string): Promise<{ ok: true; allowed: boolean; requiresPassword: boolean }>;
  openInbox(
    email: string,
    password?: string
  ): Promise<{
    ok: true;
    inbox: { email: string; label: string; requiresPassword: boolean };
    inboxToken: string | null;
    messages: MessageSummary[];
  }>;
  listMessages(options: InboxQueryOptions & { limit?: number }): Promise<MessageSummary[]>;
  getMessage(messageId: string, options: { email: string; password?: string }): Promise<FullMessage>;
  getLatestOtp(options: InboxQueryOptions): Promise<LatestOtpResponse>;
  waitForOtp(options: WaitForOtpOptions): Promise<LatestOtpResponse & { found: true; otpCode: string }>;
  waitForEmail(options: WaitForEmailOptions): Promise<FullMessage>;

  createInbox(input: {
    email_address: string;
    label?: string;
    password?: string;
    is_active?: boolean;
  }): Promise<{ ok: true; inbox: Record<string, unknown> | null }>;
  deleteInbox(
    inboxId: number,
    options?: { deleteMessages?: boolean }
  ): Promise<{ ok: true; deletedId: number; deletedMessages: boolean }>;
  clearMessages(email: string): Promise<{ ok: true; email: string; deletedCount: number }>;
  simulateEmail(input: {
    to: string;
    from?: string;
    from_name?: string;
    subject?: string;
    body_text?: string;
    body_html?: string;
  }): Promise<{ ok: true; result: { stored: boolean; id?: string; recipientEmail: string; otpCode: string | null } }>;
}
