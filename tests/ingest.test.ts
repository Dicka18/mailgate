import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSimulatedRfc822,
  ingestRawEmail,
  isValidEmailFormat,
  normalizeEmailAddress,
  parseAttachmentsJson,
  summarizeAttachments,
} from '../src/lib/email-ingest.ts';
import { handlePublicApi } from '../src/routes/public.ts';
import type { AllowedInboxRow, Env, MessageRow } from '../src/types.ts';

/**
 * Minimal in-memory D1 mock sufficient to exercise ingestRawEmail and /api/inbox/* routes.
 */
function createMockEnv(initialInboxes: Partial<AllowedInboxRow>[] = []): {
  env: Env;
  inboxes: AllowedInboxRow[];
  messages: MessageRow[];
} {
  const inboxes: AllowedInboxRow[] = initialInboxes.map((row, idx) => ({
    id: row.id ?? idx + 1,
    email_address: (row.email_address ?? '').toLowerCase(),
    label: row.label ?? '',
    password_hash: row.password_hash ?? null,
    is_active: row.is_active ?? 1,
    created_at: row.created_at ?? new Date().toISOString(),
    updated_at: row.updated_at ?? new Date().toISOString(),
  }));
  const messages: MessageRow[] = [];

  const mockDb = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bindings = args;
          return stmt;
        },
        async first<T>() {
          const normSql = sql.replace(/\s+/g, ' ').trim();
          if (normSql.includes('FROM allowed_inboxes WHERE email_address = ?1')) {
            const email = String(bindings[0]).toLowerCase();
            return (inboxes.find((i) => i.email_address === email) ?? null) as T | null;
          }
          if (normSql.includes('FROM messages') && normSql.includes('otp_code IS NOT NULL')) {
            const email = String(bindings[0]).toLowerCase();
            let matches = messages.filter((m) => m.recipient_email === email && m.otp_code !== null);
            let idx = 1;
            if (normSql.includes('received_at >=')) {
              const since = String(bindings[idx++]);
              matches = matches.filter((m) => m.received_at >= since);
            }
            if (normSql.includes('LOWER(sender) LIKE')) {
              const needle = String(bindings[idx++]).replace(/^%|%$/g, '').toLowerCase();
              matches = matches.filter((m) => m.sender.toLowerCase().includes(needle));
            }
            matches.sort((a, b) => b.received_at.localeCompare(a.received_at));
            return (matches[0] ?? null) as T | null;
          }
          if (normSql.includes('FROM messages WHERE id = ?1')) {
            const id = String(bindings[0]);
            return (messages.find((m) => m.id === id) ?? null) as T | null;
          }
          return null;
        },
        async all<T>() {
          const normSql = sql.replace(/\s+/g, ' ').trim();
          if (normSql.includes('FROM messages') && normSql.includes('recipient_email = ?1')) {
            const email = String(bindings[0]).toLowerCase();
            const matches = messages
              .filter((m) => m.recipient_email === email)
              .sort((a, b) => b.received_at.localeCompare(a.received_at));
            return { results: matches as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          const normSql = sql.replace(/\s+/g, ' ').trim();
          if (normSql.startsWith('INSERT INTO messages')) {
            messages.push({
              id: String(bindings[0]),
              recipient_email: String(bindings[1]).toLowerCase(),
              sender: String(bindings[2]),
              sender_name: String(bindings[3]),
              subject: String(bindings[4]),
              body_text: String(bindings[5]),
              body_html: String(bindings[6]),
              otp_code: bindings[7] ? String(bindings[7]) : null,
              is_read: 0,
              received_at: String(bindings[8]),
              attachments_json: bindings[9] == null ? null : String(bindings[9]),
            });
            return { meta: { changes: 1 } };
          }
          if (normSql.startsWith('UPDATE messages SET is_read = 1')) {
            const m = messages.find((row) => row.id === String(bindings[0]));
            if (m) m.is_read = 1;
            return { meta: { changes: m ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };

  const env: Env = {
    DB: mockDb as unknown as D1Database,
    ASSETS: { fetch: async () => new Response('ok') } as unknown as Fetcher,
    MAIL_DOMAIN: 'example.com',
    STRICT_ALLOWLIST: 'true',
    RETENTION_DAYS: '14',
    ALLOW_SIMULATE: 'true',
    ADMIN_TOKEN: 'test-admin-token',
    SESSION_SECRET: 'test-session-secret',
  };

  return { env, inboxes, messages };
}

test('normalizeEmailAddress and isValidEmailFormat handle angle brackets and mailto prefixes', () => {
  assert.equal(normalizeEmailAddress('  "QA User" <OTP@Example.COM> '), 'otp@example.com');
  assert.equal(normalizeEmailAddress('mailto:Verify@Example.com'), 'verify@example.com');
  assert.equal(isValidEmailFormat('otp@example.com'), true);
  assert.equal(isValidEmailFormat('not-an-email'), false);
});

test('ingestRawEmail rejects non-allowlisted recipients when STRICT_ALLOWLIST=true', async () => {
  const { env } = createMockEnv([{ email_address: 'allowed@example.com', is_active: 1 }]);
  const raw = buildSimulatedRfc822({
    to: 'blocked@example.com',
    from: 'no-reply@acme.dev',
    subject: 'Code 112233',
    bodyText: 'Your verification code is 112233',
  });

  const result = await ingestRawEmail(env, raw, 'blocked@example.com', 'no-reply@acme.dev');
  assert.equal(result.stored, false);
  assert.equal(result.reason, 'not_allowlisted');
});

test('ingestRawEmail parses RFC822 MIME, extracts OTP & link, and exposes them via /api/inbox/latest-otp', async () => {
  const { env } = createMockEnv([{ email_address: 'e2e@example.com', is_active: 1 }]);
  const beforeIso = new Date(Date.now() - 1000).toISOString();

  const raw = buildSimulatedRfc822({
    to: 'e2e@example.com',
    from: 'auth@acme.dev',
    fromName: 'Acme Auth',
    subject: 'Sign in to Acme',
    bodyText: 'Your verification code is 628-491.\n\nOr sign in directly: https://acme.dev/auth/verify?token=xyz987',
  });

  const stored = await ingestRawEmail(env, raw, 'e2e@example.com', 'auth@acme.dev');
  assert.equal(stored.stored, true);
  assert.equal(stored.otpCode, '628491');

  const req = new Request(
    `https://mailgate.test/api/inbox/latest-otp?email=e2e@example.com&since=${encodeURIComponent(beforeIso)}&sender=acme.dev`
  );
  const res = await handlePublicApi(req, env, '/api/inbox/latest-otp');
  assert.ok(res);
  assert.equal(res.status, 200);

  const json = (await res.json()) as {
    ok: boolean;
    found: boolean;
    otpCode: string | null;
    verificationLink: string | null;
    message: { sender: string } | null;
  };
  assert.equal(json.ok, true);
  assert.equal(json.found, true);
  assert.equal(json.otpCode, '628491');
  assert.equal(json.verificationLink, 'https://acme.dev/auth/verify?token=xyz987');
  assert.equal(json.message?.sender, 'auth@acme.dev');
});

function buildRawEmailWithAttachments(to: string): { raw: string; pdfSize: number; csvSize: number } {
  const boundary = 'mailgate-test-mixed';
  const pdfBytes = Buffer.from('%PDF-1.4\n% MailGate test invoice\n%%EOF\n', 'utf8');
  const csvBytes = Buffer.from('item,amount\nwidget,42\n', 'utf8');
  return {
    raw: [
      'From: "Acme Billing" <billing@acme.dev>',
      `To: ${to}`,
      'Subject: Your invoice INV-1001',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'Your invoice is attached.',
      '',
      `--${boundary}`,
      'Content-Type: application/pdf; name="INV-1001.pdf"',
      'Content-Disposition: attachment; filename="INV-1001.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      pdfBytes.toString('base64'),
      '',
      `--${boundary}`,
      'Content-Type: text/csv',
      'Content-Disposition: attachment; filename="line-items.csv"',
      'Content-Transfer-Encoding: base64',
      '',
      csvBytes.toString('base64'),
      '',
      `--${boundary}--`,
    ].join('\r\n'),
    pdfSize: pdfBytes.byteLength,
    csvSize: csvBytes.byteLength,
  };
}

test('ingestRawEmail stores attachment metadata and GET /api/inbox/messages/:id exposes it', async () => {
  const { env, messages } = createMockEnv([{ email_address: 'billing@example.com', is_active: 1 }]);
  const { raw, pdfSize, csvSize } = buildRawEmailWithAttachments('billing@example.com');

  const stored = await ingestRawEmail(env, raw, 'billing@example.com', 'billing@acme.dev');
  assert.equal(stored.stored, true);
  assert.ok(stored.id);

  const expected = [
    { filename: 'INV-1001.pdf', mimeType: 'application/pdf', size: pdfSize },
    { filename: 'line-items.csv', mimeType: 'text/csv', size: csvSize },
  ];
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0].attachments_json ?? 'null'), expected);
  assert.equal(messages[0].body_text, 'Your invoice is attached.');

  const req = new Request(`https://mailgate.test/api/inbox/messages/${stored.id}`);
  const res = await handlePublicApi(req, env, `/api/inbox/messages/${stored.id}`);
  assert.ok(res);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; message: { attachments: unknown } };
  assert.equal(json.ok, true);
  assert.deepEqual(json.message.attachments, expected);
});

test('messages without attachments store NULL and expose an empty attachments array', async () => {
  const { env, messages } = createMockEnv([{ email_address: 'e2e@example.com', is_active: 1 }]);
  const raw = buildSimulatedRfc822({
    to: 'e2e@example.com',
    from: 'auth@acme.dev',
    subject: 'Code 112233',
    bodyText: 'Your verification code is 112233',
  });

  const stored = await ingestRawEmail(env, raw, 'e2e@example.com', 'auth@acme.dev');
  assert.equal(stored.stored, true);
  assert.equal(messages[0].attachments_json, null);

  const res = await handlePublicApi(
    new Request(`https://mailgate.test/api/inbox/messages/${stored.id}`),
    env,
    `/api/inbox/messages/${stored.id}`
  );
  assert.ok(res);
  const json = (await res.json()) as { message: { attachments: unknown } };
  assert.deepEqual(json.message.attachments, []);
});

test('summarizeAttachments keeps only metadata and parseAttachmentsJson tolerates legacy or bad data', () => {
  assert.deepEqual(
    summarizeAttachments([
      { filename: '  report.PDF ', mimeType: 'Application/PDF', disposition: 'attachment', content: new Uint8Array(1234) },
      { filename: null, mimeType: '', disposition: 'inline', content: new ArrayBuffer(7) },
      { filename: 'note.txt', mimeType: 'text/plain', disposition: 'attachment', content: 'h\u00e9' },
    ]),
    [
      { filename: 'report.PDF', mimeType: 'application/pdf', size: 1234 },
      { filename: null, mimeType: 'application/octet-stream', size: 7 },
      { filename: 'note.txt', mimeType: 'text/plain', size: 3 },
    ]
  );
  assert.deepEqual(summarizeAttachments(undefined), []);

  assert.deepEqual(parseAttachmentsJson(null), []);
  assert.deepEqual(parseAttachmentsJson(undefined), []);
  assert.deepEqual(parseAttachmentsJson('not json'), []);
  assert.deepEqual(parseAttachmentsJson('{"filename":"x"}'), []);
  assert.deepEqual(parseAttachmentsJson('[{"filename":"a.pdf","mimeType":"application/pdf","size":10}, 5]'), [
    { filename: 'a.pdf', mimeType: 'application/pdf', size: 10 },
  ]);
});
