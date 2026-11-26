import type { AllowedInboxRow, Env, MessageRow } from '../types.ts';
import {
  buildCookie,
  constantTimeEqual,
  hashPassword,
  parseCookies,
  signToken,
  verifyToken,
} from '../lib/crypto.ts';
import {
  buildSimulatedRfc822,
  ingestRawEmail,
  isValidEmailFormat,
  normalizeEmailAddress,
  parseAttachmentsJson,
} from '../lib/email-ingest.ts';
import { errorJson, getSessionSecret, isSecureRequest, json, readJson } from '../lib/http.ts';
import { buildPreview, extractVerificationLink } from '../lib/otp.ts';

const ADMIN_COOKIE_NAME = 'mg_admin';
const ADMIN_TTL_SECONDS = 60 * 60 * 8; // 8 hours

async function isAdminAuthorized(request: Request, env: Env): Promise<boolean> {
  const configuredToken = env.ADMIN_TOKEN?.trim();
  if (!configuredToken) return false;

  const headerToken = request.headers.get('X-Admin-Token')?.trim();
  if (headerToken && constantTimeEqual(headerToken, configuredToken)) {
    return true;
  }

  const cookies = parseCookies(request.headers.get('Cookie'));
  const sessionCookie = cookies[ADMIN_COOKIE_NAME];
  if (!sessionCookie) return false;

  const payload = await verifyToken(sessionCookie, getSessionSecret(env));
  return Boolean(payload && payload.scope === 'admin' && payload.sub === 'owner');
}

function requireAdminGuard(authorized: boolean): Response | null {
  if (authorized) return null;
  return errorJson(
    'ADMIN_UNAUTHORIZED',
    'Admin session is invalid or expired. Sign in again with your Admin Token.',
    401
  );
}

interface InboxWithCountRow extends AllowedInboxRow {
  message_count: number;
  last_received_at: string | null;
}

export async function handleAdminApi(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response | null> {
  if (!pathname.startsWith('/api/admin')) return null;

  if (pathname === '/api/admin/session' && request.method === 'GET') {
    const authenticated = await isAdminAuthorized(request, env);
    return json({
      ok: true,
      authenticated,
      configured: Boolean(env.ADMIN_TOKEN?.trim()),
    });
  }

  if (pathname === '/api/admin/login' && request.method === 'POST') {
    const configuredToken = env.ADMIN_TOKEN?.trim();
    if (!configuredToken) {
      return errorJson(
        'ADMIN_NOT_CONFIGURED',
        'ADMIN_TOKEN is not configured on this Worker. Set it via `wrangler secret put ADMIN_TOKEN`.',
        503
      );
    }

    const body = await readJson<{ token?: string }>(request);
    const inputToken = (body?.token || '').trim();
    if (!inputToken || !constantTimeEqual(inputToken, configuredToken)) {
      return errorJson(
        'INVALID_ADMIN_TOKEN',
        'Invalid Admin Token. Check your .dev.vars file or Cloudflare Worker secrets.',
        401
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

    return json({ ok: true, authenticated: true }, 200, { 'Set-Cookie': cookie });
  }

  if (pathname === '/api/admin/logout' && request.method === 'POST') {
    const expiredCookie = buildCookie(ADMIN_COOKIE_NAME, '', {
      maxAge: 0,
      isSecure: isSecureRequest(request),
    });
    return json({ ok: true }, 200, { 'Set-Cookie': expiredCookie });
  }

  const guard = requireAdminGuard(await isAdminAuthorized(request, env));
  if (guard) return guard;

  // GET /api/admin/inboxes
  if (pathname === '/api/admin/inboxes' && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT
        a.id,
        a.email_address,
        a.label,
        a.password_hash,
        a.is_active,
        a.created_at,
        a.updated_at,
        COUNT(m.id) AS message_count,
        MAX(m.received_at) AS last_received_at
       FROM allowed_inboxes a
       LEFT JOIN messages m ON m.recipient_email = a.email_address
       GROUP BY a.id
       ORDER BY a.created_at DESC`
    ).all<InboxWithCountRow>();

    const inboxes = (results ?? []).map((row) => ({
      id: row.id,
      email_address: row.email_address.toLowerCase(),
      label: row.label,
      has_password: Boolean(row.password_hash),
      is_active: row.is_active === 1,
      message_count: Number(row.message_count ?? 0),
      last_received_at: row.last_received_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    const totalRow = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM messages').first<{ cnt: number }>();
    const activeInboxes = inboxes.filter((i) => i.is_active).length;

    return json({
      ok: true,
      inboxes,
      meta: {
        domain: env.MAIL_DOMAIN || 'example.com',
        strictAllowlist: (env.STRICT_ALLOWLIST ?? 'true').toLowerCase() !== 'false',
        allowSimulate: (env.ALLOW_SIMULATE ?? 'true').toLowerCase() === 'true',
        activeInboxes,
        totalMessages: Number(totalRow?.cnt ?? 0),
      },
    });
  }

  // POST /api/admin/inboxes
  if (pathname === '/api/admin/inboxes' && request.method === 'POST') {
    const body = await readJson<{
      email_address?: string;
      label?: string;
      password?: string;
      is_active?: boolean;
    }>(request);

    const email = normalizeEmailAddress(body?.email_address || '');
    if (!email || !isValidEmailFormat(email)) {
      return errorJson(
        'INVALID_EMAIL',
        'Invalid email address format. Provide a full address such as qa-user@example.com.',
        400
      );
    }

    const label = (body?.label || '').trim().slice(0, 120);
    const passwordRaw = (body?.password || '').trim();
    if (passwordRaw && passwordRaw.length < 4) {
      return errorJson(
        'WEAK_PASSWORD',
        'Inbox password must be at least 4 characters, or leave empty for an open inbox.',
        400
      );
    }

    const passwordHash = passwordRaw ? await hashPassword(passwordRaw) : null;
    const isActive = body?.is_active === false ? 0 : 1;

    try {
      const inserted = await env.DB.prepare(
        `INSERT INTO allowed_inboxes (email_address, label, password_hash, is_active)
         VALUES (?1, ?2, ?3, ?4)
         RETURNING id, email_address, label, password_hash, is_active, created_at, updated_at`
      )
        .bind(email, label, passwordHash, isActive)
        .first<AllowedInboxRow>();

      return json(
        {
          ok: true,
          inbox: inserted
            ? {
                id: inserted.id,
                email_address: inserted.email_address.toLowerCase(),
                label: inserted.label,
                has_password: Boolean(inserted.password_hash),
                is_active: inserted.is_active === 1,
                message_count: 0,
                last_received_at: null,
                created_at: inserted.created_at,
                updated_at: inserted.updated_at,
              }
            : null,
        },
        201
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('unique')) {
        return errorJson(
          'DUPLICATE_INBOX',
          'This inbox address is already registered. Edit it directly in the allowlist.',
          409
        );
      }
      throw err;
    }
  }

  // PATCH /api/admin/inboxes/:id
  const inboxIdMatch = pathname.match(/^\/api\/admin\/inboxes\/(\d+)$/);
  if (inboxIdMatch && request.method === 'PATCH') {
    const id = Number(inboxIdMatch[1]);
    const existing = await env.DB.prepare(
      'SELECT id, email_address, label, password_hash, is_active FROM allowed_inboxes WHERE id = ?1 LIMIT 1'
    )
      .bind(id)
      .first<AllowedInboxRow>();

    if (!existing) {
      return errorJson('INBOX_NOT_FOUND', 'Inbox not found.', 404);
    }

    const body = await readJson<{
      label?: string;
      is_active?: boolean;
      password?: string;
      clear_password?: boolean;
    }>(request);

    const nextLabel = typeof body?.label === 'string' ? body.label.trim().slice(0, 120) : existing.label;
    const nextActive = typeof body?.is_active === 'boolean' ? (body.is_active ? 1 : 0) : existing.is_active;

    let nextPasswordHash = existing.password_hash;
    if (body?.clear_password === true) {
      nextPasswordHash = null;
    } else if (typeof body?.password === 'string' && body.password.trim().length > 0) {
      if (body.password.trim().length < 4) {
        return errorJson('WEAK_PASSWORD', 'New password must be at least 4 characters.', 400);
      }
      nextPasswordHash = await hashPassword(body.password.trim());
    }

    await env.DB.prepare(
      `UPDATE allowed_inboxes
       SET label = ?1, is_active = ?2, password_hash = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?4`
    )
      .bind(nextLabel, nextActive, nextPasswordHash, id)
      .run();

    return json({
      ok: true,
      inbox: {
        id,
        email_address: existing.email_address.toLowerCase(),
        label: nextLabel,
        has_password: Boolean(nextPasswordHash),
        is_active: nextActive === 1,
      },
    });
  }

  // DELETE /api/admin/inboxes/:id
  if (inboxIdMatch && request.method === 'DELETE') {
    const id = Number(inboxIdMatch[1]);
    const url = new URL(request.url);
    const deleteMessages = url.searchParams.get('delete_messages') === 'true';

    const existing = await env.DB.prepare(
      'SELECT id, email_address FROM allowed_inboxes WHERE id = ?1 LIMIT 1'
    )
      .bind(id)
      .first<{ id: number; email_address: string }>();

    if (!existing) {
      return errorJson('INBOX_NOT_FOUND', 'Inbox not found.', 404);
    }

    await env.DB.prepare('DELETE FROM allowed_inboxes WHERE id = ?1').bind(id).run();
    if (deleteMessages) {
      await env.DB.prepare('DELETE FROM messages WHERE recipient_email = ?1')
        .bind(existing.email_address.toLowerCase())
        .run();
    }

    return json({ ok: true, deletedId: id, deletedMessages: deleteMessages });
  }

  // GET /api/admin/messages
  if (pathname === '/api/admin/messages' && request.method === 'GET') {
    const url = new URL(request.url);
    const emailFilter = normalizeEmailAddress(url.searchParams.get('email') || '');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 100);

    const query = emailFilter
      ? env.DB.prepare(
          `SELECT id, recipient_email, sender, sender_name, subject, body_text, body_html, otp_code, is_read, received_at
           FROM messages WHERE recipient_email = ?1 ORDER BY received_at DESC LIMIT ?2`
        ).bind(emailFilter, limit)
      : env.DB.prepare(
          `SELECT id, recipient_email, sender, sender_name, subject, body_text, body_html, otp_code, is_read, received_at
           FROM messages ORDER BY received_at DESC LIMIT ?1`
        ).bind(limit);

    const { results } = await query.all<MessageRow>();
    const messages = (results ?? []).map((row) => ({
      id: row.id,
      recipient_email: row.recipient_email,
      sender: row.sender,
      sender_name: row.sender_name,
      subject: row.subject,
      preview: buildPreview(row.body_text, row.body_html),
      otp_code: row.otp_code,
      is_read: row.is_read === 1,
      received_at: row.received_at,
    }));

    return json({ ok: true, messages });
  }

  // GET /api/admin/messages/:id
  const msgIdMatch = pathname.match(/^\/api\/admin\/messages\/([a-zA-Z0-9_-]+)$/);
  if (msgIdMatch && request.method === 'GET') {
    const msgId = msgIdMatch[1];
    const row = await env.DB.prepare(
      `SELECT id, recipient_email, sender, sender_name, subject, body_text, body_html, otp_code, is_read, received_at, attachments_json
       FROM messages
       WHERE id = ?1
       LIMIT 1`
    )
      .bind(msgId)
      .first<MessageRow>();

    if (!row) {
      return errorJson('MESSAGE_NOT_FOUND', 'Message not found or already deleted.', 404);
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
        is_read: row.is_read === 1,
        received_at: row.received_at,
        attachments: parseAttachmentsJson(row.attachments_json),
      },
    });
  }

  // DELETE /api/admin/messages/:id
  if (msgIdMatch && request.method === 'DELETE') {
    const msgId = msgIdMatch[1];
    await env.DB.prepare('DELETE FROM messages WHERE id = ?1').bind(msgId).run();
    return json({ ok: true, deletedId: msgId });
  }

  // DELETE /api/admin/messages?email=...
  if (pathname === '/api/admin/messages' && request.method === 'DELETE') {
    const url = new URL(request.url);
    const email = normalizeEmailAddress(url.searchParams.get('email') || '');
    if (!email) {
      return errorJson('EMAIL_REQUIRED', 'Provide the ?email= query parameter to purge an inbox.', 400);
    }
    const res = await env.DB.prepare('DELETE FROM messages WHERE recipient_email = ?1').bind(email).run();
    return json({ ok: true, email, deletedCount: res.meta.changes ?? 0 });
  }

  // POST /api/admin/simulate (Tests full RFC822 -> PostalMime -> OTP Extractor -> D1 pipeline)
  if (pathname === '/api/admin/simulate' && request.method === 'POST') {
    if ((env.ALLOW_SIMULATE ?? 'true').toLowerCase() !== 'true') {
      return errorJson('SIMULATE_DISABLED', 'Email simulation is disabled in Worker configuration.', 403);
    }

    const body = await readJson<{
      to?: string;
      from?: string;
      from_name?: string;
      subject?: string;
      body_text?: string;
      body_html?: string;
    }>(request);

    const to = normalizeEmailAddress(body?.to || '');
    const from = normalizeEmailAddress(body?.from || 'no-reply@verify.example');
    if (!to || !isValidEmailFormat(to)) {
      return errorJson('INVALID_EMAIL', 'Invalid recipient address for simulated email.', 400);
    }

    const randomOtp = String(Math.floor(100000 + Math.random() * 900000));
    const subject = (body?.subject || '').trim() || `Your verification code: ${randomOtp}`;
    const bodyText =
      (body?.body_text || '').trim() ||
      `Use the one-time code below to verify your sign-in:\n\n${randomOtp}\n\nThis code expires in 10 minutes.`;

    const rawRfc822 = buildSimulatedRfc822({
      to,
      from,
      fromName: (body?.from_name || 'MailGate Simulator').trim(),
      subject,
      bodyText,
      bodyHtml: body?.body_html,
    });

    const result = await ingestRawEmail(env, rawRfc822, to, from);
    if (!result.stored) {
      return errorJson(
        'INGEST_REJECTED',
        result.reason === 'not_allowlisted'
          ? 'Message rejected because the recipient is not active in allowed_inboxes (STRICT_ALLOWLIST is enabled).'
          : 'Message could not be processed due to an invalid recipient address.',
        422,
        { reason: result.reason }
      );
    }

    return json({ ok: true, result }, 201);
  }

  return null;
}
