import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import {
  MailGateClient,
  MailGateError,
  MailGateTimeoutError,
  verifyMailGateWebhook,
} from '../sdk/index.mjs';

/**
 * Creates a signature using the MailGate webhook signing format.
 * @param {string} secret Shared webhook secret.
 * @param {string} timestamp Unix timestamp in seconds.
 * @param {string} rawBody Exact request body string.
 * @returns {string} HMAC-SHA256 signature in hexadecimal.
 */
function signWebhookPayload(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Verifies valid, tampered, malformed, and expired MailGate webhook signatures.
 * @returns {Promise<void>}
 */
async function testVerifyMailGateWebhook() {
  const secret = 'webhook-shared-secret';
  const rawBody = JSON.stringify({ to: 'otp@example.com', subject: 'Code 123456' });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const timestamp = String(nowSeconds);
  const signature = signWebhookPayload(secret, timestamp, rawBody);

  assert.equal(await verifyMailGateWebhook({ rawBody, signature, timestamp, secret }), true);
  assert.equal(
    await verifyMailGateWebhook({ rawBody: `${rawBody} `, signature, timestamp, secret }),
    false
  );
  assert.equal(
    await verifyMailGateWebhook({
      rawBody,
      signature: `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`,
      timestamp,
      secret,
    }),
    false
  );
  assert.equal(await verifyMailGateWebhook({ rawBody, signature: 'bad', timestamp, secret }), false);

  const expiredTimestamp = String(nowSeconds - 301);
  const expiredSignature = signWebhookPayload(secret, expiredTimestamp, rawBody);
  assert.equal(
    await verifyMailGateWebhook({ rawBody, signature: expiredSignature, timestamp: expiredTimestamp, secret }),
    false
  );

  const shortWindowTimestamp = String(nowSeconds - 30);
  const shortWindowSignature = signWebhookPayload(secret, shortWindowTimestamp, rawBody);
  assert.equal(
    await verifyMailGateWebhook({
      rawBody,
      signature: shortWindowSignature,
      timestamp: shortWindowTimestamp,
      secret,
      maxDriftSeconds: 10,
    }),
    false
  );
  assert.equal(await verifyMailGateWebhook({ rawBody, signature, timestamp: 'invalid', secret }), false);
}

test('verifyMailGateWebhook validates HMAC and replay window', testVerifyMailGateWebhook);

function startMockMailGateServer() {
  let otpPolls = 0;
  let lastAuthHeader = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/health' && req.method === 'GET') {
      return send(200, { ok: true, service: 'mailgate', version: '1.0.0', timestamp: new Date().toISOString() });
    }

    if (url.pathname === '/api/inbox/open' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (body.password !== 'secret123') {
          return send(401, { ok: false, error: { code: 'INVALID_PASSWORD', message: 'Wrong password' } });
        }
        return send(200, {
          ok: true,
          inbox: { email: body.email, label: 'Locked QA', requiresPassword: true },
          inboxToken: 'signed-inbox-token-xyz',
          messages: [],
        });
      });
      return;
    }

    if (url.pathname === '/api/inbox/latest-otp' && req.method === 'GET') {
      lastAuthHeader = String(req.headers['x-inbox-token'] || '');
      if (url.searchParams.get('email') === 'timeout@example.com') {
        return send(200, { ok: true, found: false, otpCode: null, verificationLink: null, message: null });
      }
      otpPolls += 1;
      if (otpPolls < 3) {
        return send(200, { ok: true, found: false, otpCode: null, verificationLink: null, message: null });
      }
      return send(200, {
        ok: true,
        found: true,
        otpCode: '741852',
        verificationLink: 'https://app.example.com/verify?token=t1',
        message: {
          id: 'msg-101',
          recipient_email: url.searchParams.get('email'),
          sender: 'auth@example.com',
          sender_name: 'Auth Bot',
          subject: 'Code 741852',
          received_at: new Date().toISOString(),
        },
      });
    }

    if (url.pathname === '/api/inbox/messages' && req.method === 'GET') {
      return send(200, {
        ok: true,
        email: url.searchParams.get('email'),
        messages: [
          {
            id: 'msg-magic-1',
            recipient_email: url.searchParams.get('email'),
            sender: 'no-reply@acme.dev',
            sender_name: 'Acme',
            subject: 'Your Magic Sign-In Link',
            preview: 'Click to sign in',
            otp_code: null,
            is_read: false,
            received_at: new Date().toISOString(),
          },
        ],
      });
    }

    if (url.pathname === '/api/inbox/messages/msg-magic-1' && req.method === 'GET') {
      return send(200, {
        ok: true,
        message: {
          id: 'msg-magic-1',
          recipient_email: 'magic@example.com',
          sender: 'no-reply@acme.dev',
          sender_name: 'Acme',
          subject: 'Your Magic Sign-In Link',
          body_text: 'Open https://acme.dev/magic?t=ok123',
          body_html: '<a href="https://acme.dev/magic?t=ok123">Sign in</a>',
          otp_code: null,
          verification_link: 'https://acme.dev/magic?t=ok123',
          is_read: true,
          received_at: new Date().toISOString(),
        },
      });
    }

    return send(404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        getPolls: () => otpPolls,
        getLastAuthHeader: () => lastAuthHeader,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test('MailGateClient waitForOtp caches inbox token and resolves after polling', async () => {
  const srv = await startMockMailGateServer();
  try {
    const client = new MailGateClient({ baseUrl: srv.baseUrl });
    const health = await client.health();
    assert.equal(health.service, 'mailgate');

    const res = await client.waitForOtp({
      email: 'locked@example.com',
      password: 'secret123',
      timeoutMs: 3000,
      pollIntervalMs: 25,
    });

    assert.equal(res.otpCode, '741852');
    assert.equal(srv.getPolls(), 3);
    assert.equal(srv.getLastAuthHeader(), 'signed-inbox-token-xyz');
  } finally {
    await srv.close();
  }
});

test('MailGateClient waitForOtp throws MailGateTimeoutError when deadline expires', async () => {
  const srv = await startMockMailGateServer();
  try {
    const client = new MailGateClient({ baseUrl: srv.baseUrl });
    await assert.rejects(
      () =>
        client.waitForOtp({
          email: 'timeout@example.com',
          timeoutMs: 90,
          pollIntervalMs: 20,
        }),
      MailGateTimeoutError
    );
  } finally {
    await srv.close();
  }
});

test('MailGateClient waitForEmail filters by subjectIncludes and returns verification_link', async () => {
  const srv = await startMockMailGateServer();
  try {
    const client = new MailGateClient({ baseUrl: srv.baseUrl });
    const msg = await client.waitForEmail({
      email: 'magic@example.com',
      subjectIncludes: 'magic sign-in',
      timeoutMs: 1000,
      pollIntervalMs: 20,
    });
    assert.equal(msg.verification_link, 'https://acme.dev/magic?t=ok123');
  } finally {
    await srv.close();
  }
});

test('MailGateClient surfaces structured MailGateError on invalid credentials', async () => {
  const srv = await startMockMailGateServer();
  try {
    const client = new MailGateClient({ baseUrl: srv.baseUrl });
    await assert.rejects(
      () => client.openInbox('locked@example.com', 'bad-pass'),
      (err) => err instanceof MailGateError && err.status === 401 && err.code === 'INVALID_PASSWORD'
    );
  } finally {
    await srv.close();
  }
});
