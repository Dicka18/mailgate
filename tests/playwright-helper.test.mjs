import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createMailGateTest } from '../sdk/playwright.mjs';
import { addMailGateCommands } from '../sdk/cypress.mjs';

test('Cypress commands register OTP and email helpers and require a configured email', () => {
  const commands = new Map();
  const fakeCypress = {
    env: (name) => ({ MAILGATE_URL: 'http://127.0.0.1' })[name],
    Commands: { add: (name, command) => commands.set(name, command) },
  };

  addMailGateCommands(fakeCypress);

  assert.deepEqual([...commands.keys()], ['waitForOtp', 'waitForEmail']);
  assert.throws(() => commands.get('waitForOtp')(), /requires `email`/);
});

test('createMailGateTest wires mailgate fixture, clears inbox when requested, and injects `since`', async () => {
  let clearedEmail = '';
  let seenSince = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (url.pathname === '/api/admin/messages' && req.method === 'DELETE') {
      clearedEmail = url.searchParams.get('email') || '';
      return res.end(JSON.stringify({ ok: true, email: clearedEmail, deletedCount: 2 }));
    }
    if (url.pathname === '/api/inbox/latest-otp') {
      seenSince = url.searchParams.get('since') || '';
      return res.end(
        JSON.stringify({
          ok: true,
          found: true,
          otpCode: '402918',
          verificationLink: null,
          message: { id: 'p1', sender: 'auth@example.com', subject: '402918', received_at: new Date().toISOString() },
        })
      );
    }
    return res.end(JSON.stringify({ ok: true }));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let registeredFixture = null;
    const fakePlaywrightBase = {
      extend(fixtures) {
        registeredFixture = fixtures.mailgate;
        return { fixtures };
      },
    };

    createMailGateTest(fakePlaywrightBase, {
      baseUrl,
      adminToken: 'adm-123',
      defaultEmail: 'pw@example.com',
      clearBeforeEach: true,
    });

    assert.equal(typeof registeredFixture, 'function');

    let receivedOtp = null;
    await registeredFixture({}, async (mailgate) => {
      const res = await mailgate.waitForOtp({ timeoutMs: 1000, pollIntervalMs: 20 });
      receivedOtp = res.otpCode;
    });

    assert.equal(clearedEmail, 'pw@example.com');
    assert.ok(seenSince.length > 10, 'Expected automatic ISO `since` query parameter');
    assert.equal(receivedOtp, '402918');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
