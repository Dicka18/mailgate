import type { AllowedInboxRow, Env, MessageRow, MessageSummary } from '../types.ts';
import { buildCookie, constantTimeEqual, signToken, verifyPassword, verifyToken } from '../lib/crypto.ts';
import { isValidEmailFormat, normalizeEmailAddress, parseAttachmentsJson } from '../lib/email-ingest.ts';
import { errorJson, getSessionSecret, isSecureRequest, json, readJson } from '../lib/http.ts';
import { buildPreview, extractVerificationLink } from '../lib/otp.ts';

const INBOX_TOKEN_TTL_SECONDS = 60 * 60 * 2; // 2 hours
const ADMIN_COOKIE_NAME = 'mg_admin';
const ADMIN_TTL_SECONDS = 60 * 60 * 8; // 8 hours

async function getInboxRecord(env: Env, email: string): Promise<AllowedInboxRow | null> {
  return env.DB.prepare(
    'SELECT id, email_address, label, password_hash, is_active, created_at, updated_at FROM allowed_inboxes WHERE email_address = ?1 LIMIT 1'
  )
    .bind(email)
    .first<AllowedInboxRow>();
}

async function authorizeInboxAccess(
  request: Request,
  env: Env,
  email: string
): Promise<{ ok: true; inbox: AllowedInboxRow } | { ok: false; response: Response }> {
  const inbox = await getInboxRecord(env, email);
  if (!inbox || inbox.is_active !== 1) {
    return {
      ok: false,
      response: errorJson(
        'INBOX_NOT_ALLOWED',
        'This inbox address is not allowlisted or is currently disabled.',
        403
      ),
    };
  }

  if (inbox.password_hash) {
    const token = request.headers.get('X-Inbox-Token')?.trim() || '';
    const payload = token ? await verifyToken(token, getSessionSecret(env)) : null;
    if (!payload || payload.scope !== 'inbox' || payload.sub !== inbox.email_address.toLowerCase()) {
      return {
        ok: false,
        response: errorJson(
          'PASSWORD_REQUIRED',
          'This inbox is password-protected. Authenticate via POST /api/inbox/open first.',
          401,
          { requiresPassword: true }
        ),
      };
    }
  }

  return { ok: true, inbox };
}

function toSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    recipient_email: row.recipient_email,
    sender: row.sender,
    sender_name: row.sender_name,
    subject: row.subject,
    preview: buildPreview(row.body_text, row.body_html),
    otp_code: row.otp_code,
    is_read: row.is_read === 1,
    received_at: row.received_at,
  };
}

function parseSinceParam(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const numeric = Number(trimmed);
  const d = Number.isFinite(numeric) && /^\d{10,13}$/.test(trimmed)
    ? new Date(trimmed.length === 10 ? numeric * 1000 : numeric)
    : new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

async function fetchInboxMessages(
  env: Env,
  email: string,
  options: { limit?: number; since?: string | null; sender?: string | null } = {}
): Promise<MessageSummary[]> {
  const safeLimit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const conditions = ['recipient_email = ?1'];
  const bindings: unknown[] = [email];

  if (options.since) {
    bindings.push(options.since);
    conditions.push(`received_at >= ?${bindings.length}`);
  }
  if (options.sender) {
    bindings.push(`%${options.sender.toLowerCase()}%`);
    conditions.push(`LOWER(sender) LIKE ?${bindings.length}`);
  }

  bindings.push(safeLimit);
  const sql = `SELECT id, recipient_email, sender, sender_name, subject, body_text, body_html, otp_code, is_read, received_at
               FROM messages
               WHERE ${conditions.join(' AND ')}
               ORDER BY received_at DESC
               LIMIT ?${bindings.length}`;

  const { results } = await env.DB.prepare(sql)
    .bind(...bindings)
    .all<MessageRow>();

  return (results ?? []).map(toSummary);
}

export async function handlePublicApi(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  if (pathname === '/api/health' && request.method === 'GET') {
    return json({
      ok: true,
      service: 'mailgate',
      version: '1.1.0',
      timestamp: new Date().toISOString(),
    });
  }

  if (pathname === '/api/config' && request.method === 'GET') {
    return json({
      ok: true,
      domain: env.MAIL_DOMAIN || 'example.com',
      strictAllowlist: (env.STRICT_ALLOWLIST ?? 'true').toLowerCase() !== 'false',
    });
  }

  if (pathname === '/api/inbox/check' && request.method === 'POST') {
    const body = await readJson<{ email?: string }>(request);
    const email = normalizeEmailAddress(body?.email || '');
    if (!email || !isValidEmailFormat(email)) {
      return errorJson('INVALID_EMAIL', 'Invalid email address format.', 400);
    }

    const adminEmail = normalizeEmailAddress(env.ADMIN_EMAIL || '');
    const adminToken = (env.ADMIN_TOKEN || '').trim();
    if (adminEmail && adminToken && constantTimeEqual(adminEmail, email)) {
      return json({
        ok: true,
        allowed: true,
        requiresPassword: true,
      });
    }

    const inbox = await getInboxRecord(env, email);
    if (!inbox || inbox.is_active !== 1) {
      return json({
        ok: true,
        allowed: false,
        requiresPassword: false,
      });
    }

    return json({
      ok: true,
      allowed: true,
      requiresPassword: Boolean(inbox.password_hash),
    });
  }

  if (pathname === '/api/inbox/open' && request.method === 'POST') {
    const body = await readJson<{ email?: string; password?: string }>(request);
    const email = normalizeEmailAddress(body?.email || '');
    if (!email || !isValidEmailFormat(email)) {
      return errorJson(
        'INVALID_EMAIL',
        'Invalid email address format. Use a full address such as otp@example.com.',
        400
      );
    }

    const adminEmail = normalizeEmailAddress(env.ADMIN_EMAIL || '');
    const adminToken = (env.ADMIN_TOKEN || '').trim();
    if (adminEmail && adminToken && constantTimeEqual(adminEmail, email)) {
      const password = body?.password ?? '';
      if (!password) {
        return errorJson(
          'PASSWORD_REQUIRED',
          'This account is password-protected. Enter your password to continue.',
          401,
          { requiresPassword: true }
        );
      }
      if (!constantTimeEqual(adminToken, password)) {
        return errorJson(
          'INVALID_PASSWORD',
          'Incorrect password. Check capitalization and try again.',
          401,
          { requiresPassword: true }
        );
      }

      const signed = await signToken(
        {
          scope: 'admin',
          sub: 'owner',
          exp: Math.floor(Date.now() / 1000) + ADMIN_TTL_SECONDS,
        },
        getSessionSecret(env)
      );

      const cookie = buildCookie(ADMIN_COOKIE_NAME, signed, {
        maxAge: ADMIN_TTL_SECONDS,
        isSecure: isSecureRequest(request),
      });

      return json({ ok: true, role: 'admin' }, 200, { 'Set-Cookie': cookie });
    }

    const inbox = await getInboxRecord(env, email);
    if (!inbox || inbox.is_active !== 1) {
      return errorJson(
        'INBOX_NOT_ALLOWED',
        'This inbox is not registered in the allowlist or is currently disabled.',
        403
      );
    }

    let inboxToken: string | null = null;
    if (inbox.password_hash) {
      const password = body?.password ?? '';
      if (!password) {
        return errorJson(
          'PASSWORD_REQUIRED',
          'This inbox is password-protected. Enter the inbox password to open it.',
          401,
          { requiresPassword: true }
        );
      }

      const valid = await verifyPassword(password, inbox.password_hash);
      if (!valid) {
        return errorJson(
          'INVALID_PASSWORD',
          'Incorrect inbox password. Check capitalization and try again.',
          401,
          { requiresPassword: true }
        );
      }

      inboxToken = await signToken(
        {
          scope: 'inbox',
          sub: inbox.email_address.toLowerCase(),
          exp: Math.floor(Date.now() / 1000) + INBOX_TOKEN_TTL_SECONDS,
        },
        getSessionSecret(env)
      );
    }

    const messages = await fetchInboxMessages(env, inbox.email_address.toLowerCase());
    return json({
      ok: true,
      inbox: {
        email: inbox.email_address.toLowerCase(),
        label: inbox.label,
        requiresPassword: Boolean(inbox.password_hash),
      },
      inboxToken,
      messages,
    });
  }

  if (pathname === '/api/inbox/messages' && request.method === 'GET') {
    const url = new URL(request.url);
    const email = normalizeEmailAddress(url.searchParams.get('email') || '');
    if (!email || !isValidEmailFormat(email)) {
      return errorJson('INVALID_EMAIL', 'Missing or invalid ?email= query parameter.', 400);
    }

    const auth = await authorizeInboxAccess(request, env, email);
    if (!auth.ok) return auth.response;

    const limit = Number(url.searchParams.get('limit') || 50);
    const since = parseSinceParam(url.searchParams.get('since'));
    const sender = (url.searchParams.get('sender') || '').trim() || null;

    const messages = await fetchInboxMessages(env, auth.inbox.email_address.toLowerCase(), {
      limit: Number.isFinite(limit) ? limit : 50,
      since,
      sender,
    });

    return json({
      ok: true,
      email: auth.inbox.email_address.toLowerCase(),
      messages,
    });
  }

  /**
   * GET /api/inbox/latest-otp?email=...&since=...&sender=...
   * Dedicated E2E automation endpoint returning the newest extracted OTP & magic link.
   */
  if (pathname === '/api/inbox/latest-otp' && request.method === 'GET') {
    const url = new URL(request.url);
    const email = normalizeEmailAddress(url.searchParams.get('email') || '');
    if (!email || !isValidEmailFormat(email)) {
      return errorJson('INVALID_EMAIL', 'Missing or invalid ?email= query parameter.', 400);
    }

    const auth = await authorizeInboxAccess(request, env, email);
    if (!auth.ok) return auth.response;

    const since = parseSinceParam(url.searchParams.get('since'));
    const sender = (url.searchParams.get('sender') || '').trim().toLowerCase();

    const conditions = ['recipient_email = ?1', 'otp_code IS NOT NULL'];
    const bindings: unknown[] = [auth.inbox.email_address.toLowerCase()];

    if (since) {
      bindings.push(since);
      conditions.push(`received_at >= ?${bindings.length}`);
    }
    if (sender) {
      bindings.push(`%${sender}%`);
      conditions.push(`LOWER(sender) LIKE ?${bindings.length}`);
    }

    const row = await env.DB.prepare(
      `SELECT id, recipient_email, sender, sender_name, subject, body_text, body_html, otp_code, is_read, received_at
       FROM messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY received_at DESC
       LIMIT 1`
    )
      .bind(...bindings)
      .first<MessageRow>();

    if (!row) {
      return json({
        ok: true,
        found: false,
        otpCode: null,
        verificationLink: null,
        message: null,
      });
    }

    return json({
      ok: true,
      found: true,
      otpCode: row.otp_code,
      verificationLink: extractVerificationLink(row.body_text, row.body_html),
      message: {
        id: row.id,
        recipient_email: row.recipient_email,
        sender: row.sender,
        sender_name: row.sender_name,
        subject: row.subject,
        received_at: row.received_at,
      },
    });
  }

  const singleMatch = pathname.match(/^\/api\/inbox\/messages\/([a-zA-Z0-9_-]+)$/);
  if (singleMatch && request.method === 'GET') {
    const messageId = singleMatch[1];
    const row = await env.DB.prepare(
      `SELECT id, recipient_email, sender, sender_name, subject, body_text, body_html, otp_code, is_read, received_at, attachments_json
       FROM messages
       WHERE id = ?1
       LIMIT 1`
    )
      .bind(messageId)
      .first<MessageRow>();

    if (!row) {
      return errorJson('MESSAGE_NOT_FOUND', 'Message not found or already deleted.', 404);
    }

    const auth = await authorizeInboxAccess(request, env, row.recipient_email.toLowerCase());
    if (!auth.ok) return auth.response;

    if (row.is_read === 0) {
      await env.DB.prepare('UPDATE messages SET is_read = 1 WHERE id = ?1').bind(row.id).run();
    }

    return json({
      ok: true,
      message: {
        id: row.id,
        recipient_email: row.recipient_email,
        sender: row.sender,
        sender_name: row.sender_name,
        subject: row.subject,
        body_text: row.body_text,
        body_html: row.body_html,
        otp_code: row.otp_code,
        verification_link: extractVerificationLink(row.body_text, row.body_html),
        is_read: true,
        received_at: row.received_at,
        attachments: parseAttachmentsJson(row.attachments_json),
      },
    });
  }

  return null;
}
