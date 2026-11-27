# `mailgate-sdk`

Zero-dependency JavaScript/TypeScript client SDK, CLI, Playwright fixture, and stdio **MCP server** for [MailGate](https://github.com/Dicka18/mailgate) (self-hosted OTP and magic-link inbox on Cloudflare Workers + D1).

## Install

```bash
npm install -D mailgate-sdk
```

---

## 1. MCP Server for Claude Code, Cursor, & AI Agents

When an AI coding agent tests a web app login or signup screen, it usually gets stuck at "Enter the 6-digit code sent to your email." `mailgate-mcp` gives the agent direct access to your self-hosted MailGate inbox over stdio JSON-RPC (zero extra dependencies).

### Claude Code (1 command)

```bash
claude mcp add mailgate \
  -e MAILGATE_URL=https://mailgate.example.com \
  -e MAILGATE_ADMIN_TOKEN=your-optional-admin-token \
  -- npx -y mailgate-sdk mcp
```

### Cursor / Windsurf / Claude Desktop (`mcp.json`)

```json
{
  "mcpServers": {
    "mailgate": {
      "command": "npx",
      "args": ["-y", "mailgate-sdk", "mcp"],
      "env": {
        "MAILGATE_URL": "https://mailgate.example.com",
        "MAILGATE_ADMIN_TOKEN": "optional-admin-token"
      }
    }
  }
}
```

### Exposed MCP Tools

- `mailgate_health`: verify Worker availability
- `mailgate_wait_for_otp`: poll until a fresh OTP code arrives (`email`, optional `since`, `sender`, `password`, `timeoutMs`)
- `mailgate_wait_for_email`: wait for a full email and return `body_text`, `otp_code`, and `verification_link`
- `mailgate_list_messages`: list recent messages in an inbox
- `mailgate_get_message`: read a message by ID, including its full text body and attachment metadata
- `mailgate_create_inbox`: allowlist a new inbox (`MAILGATE_ADMIN_TOKEN` required)
- `mailgate_clear_messages`: purge stored messages before a fresh test (`MAILGATE_ADMIN_TOKEN` required)
- `mailgate_simulate_email`: inject a simulated RFC822 message (`MAILGATE_ADMIN_TOKEN` required)

---

## 2. Playwright Fixture (`mailgate-sdk/playwright`)

`createMailGateTest` wraps Playwright's `test` and automatically scopes `since` to each test's start time so stale OTPs from earlier runs are ignored:

```ts
import { test as base, expect } from '@playwright/test';
import { createMailGateTest } from 'mailgate-sdk/playwright';

const test = createMailGateTest(base, {
  baseUrl: process.env.MAILGATE_URL!,
  defaultEmail: 'e2e-login@example.com',
});

test('sign in with email OTP', async ({ page, mailgate }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-login@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();

  const { otpCode } = await mailgate.waitForOtp({ sender: 'no-reply@yourapp.com' });

  await page.getByLabel('Verification code').fill(otpCode);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/dashboard');
});
```

---

## 3. Cypress Commands (`mailgate-sdk/cypress`)

Register `cy.waitForOtp()` and `cy.waitForEmail()` in your Cypress support file. Set the MailGate URL in Cypress config or pass it directly:

```js
import { addMailGateCommands } from 'mailgate-sdk/cypress';

addMailGateCommands(Cypress, {
  baseUrl: Cypress.env('MAILGATE_URL'),
  adminToken: Cypress.env('MAILGATE_ADMIN_TOKEN'),
  defaultEmail: 'e2e-login@example.com',
});
```

Use the command in a test and pass the same filters supported by `MailGateClient`:

```js
cy.get('[aria-label="Email"]').type('e2e-login@example.com');
cy.get('button[type="submit"]').click();

cy.waitForOtp({
  since: new Date(Date.now() - 60_000),
  sender: 'no-reply@example.com',
  timeoutMs: 30_000,
}).then(({ otpCode }) => {
  cy.get('[aria-label="Verification code"]').type(otpCode);
  cy.get('button[type="submit"]').click();
});
```

Pass `email` to each command or set it once as `defaultEmail`. The `since`, `sender`, timeout and other inbox options are passed to the client. Cypress is provided by your test suite; this helper adds no SDK dependency.

## 4. Direct Client API (`MailGateClient`)

```ts
import { MailGateClient } from 'mailgate-sdk';

const mailgate = new MailGateClient({
  baseUrl: process.env.MAILGATE_URL!,
  adminToken: process.env.MAILGATE_ADMIN_TOKEN,
});

const { otpCode } = await mailgate.waitForOtp({
  email: 'e2e@example.com',
  since: new Date(),
  timeoutMs: 30_000,
});

const msg = await mailgate.waitForEmail({
  email: 'e2e@example.com',
  subjectIncludes: 'Sign in',
});
console.log(msg.verification_link);
```

---

## 5. CLI Usage (CI Shell Scripts)

```bash
export MAILGATE_URL=https://mailgate.example.com

# Wait for the newest OTP and print only the code to stdout
OTP=$(npx mailgate-sdk otp e2e@example.com --timeout 30000)

# Wait for a magic verification link
LINK=$(npx mailgate-sdk link e2e@example.com --subject "Sign in")

# List messages as JSON
npx mailgate-sdk messages e2e@example.com
```
