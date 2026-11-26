# MailGate

[![CI](https://github.com/Dicka18/mailgate/actions/workflows/ci.yml/badge.svg)](https://github.com/Dicka18/mailgate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Dicka18/mailgate/actions/workflows/codeql.yml/badge.svg)](https://github.com/Dicka18/mailgate/actions/workflows/codeql.yml)
[![npm version](https://img.shields.io/npm/v/mailgate-sdk?color=0f766e&label=mailgate-sdk)](https://www.npmjs.com/package/mailgate-sdk)
[![npm downloads](https://img.shields.io/npm/dm/mailgate-sdk?color=0f766e)](https://www.npmjs.com/package/mailgate-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f766e.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/Dicka18/mailgate?color=0f766e)](https://github.com/Dicka18/mailgate/releases)

Self-hosted, receive-only email and OTP inbox running on Cloudflare Email Routing, Workers, and D1.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Dicka18/mailgate)

Turn any domain on Cloudflare into a private inbox for verification codes, magic sign-in links, and Playwright/Cypress E2E tests without running an SMTP server or paying for hosted QA sandboxes.

![MailGate Web Inbox Preview](./docs/preview.png)

---

## Comparison

| Feature | MailGate (Self-Hosted) | Hosted QA Sandboxes (Mailosaur / Mailtrap) | Public Temp Mail (Mailinator) |
| --- | --- | --- | --- |
| **Hosting Cost** | **\$0/mo** (Cloudflare Free Tier) | \$15 to \$99+/mo | Free (public) / Paid (private) |
| **Custom Domain (`*@yourdomain.com`)** | Built-in via Cloudflare Email Routing | Paid tiers | Paid tiers |
| **Private / Locked Inboxes** | Strict allowlist + PBKDF2 passwords | Yes | Public by default |
| **OTP & Magic-Link API (`waitForOtp`)** | `/api/inbox/latest-otp` + `mailgate-sdk` | Yes | Paid tiers |
| **Infrastructure** | Cloudflare Worker + D1 SQLite + Cron | Managed | Managed |
| **Data Ownership** | Inside your Cloudflare account | Third-party cloud | Public / Third-party |

## Architecture

```mermaid
flowchart LR
  Sender["Auth Provider / App<br/>(OTP, Magic Link, Receipt)"] -->|SMTP| CF["Cloudflare Email Routing<br/>(*@example.com)"]
  CF -->|email() handler| Worker["MailGate Worker<br/>(postal-mime + sanitizer + OTP extractor)"]
  Worker -->|Strict allowlist check| D1[("Cloudflare D1<br/>SQLite")]
  Cron["Daily Cron Trigger<br/>(03:00 UTC)"] -->|Purge expired mail| D1
  Browser["Web Inbox & Admin UI<br/>(Sandboxed iframe + Light/Dark)"] <-->|HTTPS JSON API| Worker
  E2E["Playwright / Cypress / CI<br/>(mailgate-sdk)"] <-->|GET /api/inbox/latest-otp| Worker
```

---

## What It Includes

- **Receive-only inbox**: No outbound SMTP relay and no VPS to maintain.
- **Strict allowlist and optional passwords**: Rejects unlisted addresses at the SMTP edge (`STRICT_ALLOWLIST = "true"`). Lock specific inboxes with PBKDF2-SHA256 (100,000 iterations) passwords and signed HMAC-SHA256 tokens.
- **OTP and magic-link extraction**: Extracts 4-8 digit and hyphenated (`417-932`) verification codes plus sign-in links while ignoring calendar years (`1990` to `2035`) in invoices and footers.
- **E2E testing API and SDK**: Query `GET /api/inbox/latest-otp` (`since` and `sender` filters) directly or use [`mailgate-sdk`](https://www.npmjs.com/package/mailgate-sdk) (`waitForOtp()`, `waitForEmail()`).
- **Safe HTML rendering**: Sanitizes incoming email HTML on ingest and renders message bodies inside `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox">` under a strict CSP (`script-src 'self'`).
- **Built-in RFC822 simulator and admin panel**: Test the `PostalMime -> Sanitizer -> OTP -> D1` pipeline locally without waiting for SMTP delivery, export CSVs, and clear inboxes in one click.
- **Optional webhook bridge**: If you want to store emails in Postgres, MySQL, or your own backend instead of D1, deploy [`cloudflare-bridge/`](./cloudflare-bridge/README.md) to forward HMAC-SHA256 signed JSON webhooks.

---

## Quickstart

### 1. Run Locally

```bash
git clone https://github.com/Dicka18/mailgate.git
cd mailgate
npm install
cp .dev.vars.example .dev.vars
```

Apply local D1 migrations, seed sample messages, and start Wrangler:

```bash
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Open `http://localhost:8787`:
- Enter `otp@example.com` (open inbox, no password needed) to view the sample messages.
- Sign in with `ADMIN_EMAIL` and `ADMIN_TOKEN` from `.dev.vars` to open the Admin Panel (allowlist management, RFC822 simulator, and stored messages).

### 2. Deploy to Cloudflare

```bash
# 1. Create the D1 database and paste the returned database_id into wrangler.toml
npx wrangler d1 create mailgate-db

# 2. Apply schema to production D1
npm run db:migrate:remote

# 3. Set production secrets
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SESSION_SECRET

# 4. Deploy Worker + static UI
npm run deploy
```

Then enable **Cloudflare Email Routing** on your domain:
1. Open Cloudflare Dashboard -> **Email** -> **Email Routing**.
2. Go to **Routing rules** -> **Catch-all address** -> Edit.
3. Set Action to **Send to a Worker** and choose **`mailgate`**.

---

## MCP Server for Claude Code & AI Agents

If you use Claude Code, Cursor, or another MCP-compatible coding agent to test web apps in a browser, the agent usually gets stuck at email OTP or magic-link screens. `mailgate-sdk` bundles a zero-dependency stdio MCP server (`mailgate-mcp`) that exposes `mailgate_wait_for_otp`, `mailgate_wait_for_email`, `mailgate_list_messages`, `mailgate_create_inbox`, `mailgate_clear_messages`, and `mailgate_simulate_email`.

Add it to Claude Code in one command:

```bash
claude mcp add mailgate \
  -e MAILGATE_URL=https://mailgate.example.com \
  -e MAILGATE_ADMIN_TOKEN=optional-admin-token \
  -- npx -y mailgate-sdk mcp
```

Or drop it into `.cursor/mcp.json` / Claude Desktop config:

```json
{
  "mcpServers": {
    "mailgate": {
      "command": "npx",
      "args": ["-y", "mailgate-sdk", "mcp"],
      "env": {
        "MAILGATE_URL": "https://mailgate.example.com"
      }
    }
  }
}
```

---

## Playwright / CI Usage (`mailgate-sdk`)

Install the zero-dependency SDK from npm (`npm install -D mailgate-sdk`) or see [`./sdk/README.md`](./sdk/README.md).

### Playwright Fixture (`mailgate-sdk/playwright`)

`createMailGateTest` automatically sets `since` to each test's start time so stale OTPs from earlier runs are ignored:

```ts
import { test as base, expect } from '@playwright/test';
import { createMailGateTest } from 'mailgate-sdk/playwright';

const test = createMailGateTest(base, {
  baseUrl: process.env.MAILGATE_URL!,
  defaultEmail: 'e2e-auth@example.com',
});

test('user can sign in via email OTP', async ({ page, mailgate }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('e2e-auth@example.com');
  await page.getByRole('button', { name: 'Send verification code' }).click();

  const { otpCode } = await mailgate.waitForOtp({
    sender: 'no-reply@yourapp.com',
    timeoutMs: 30_000,
  });

  await page.getByLabel('Code').fill(otpCode);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL('/dashboard');
});
```

### Shell / CI CLI

```bash
OTP=$(MAILGATE_URL=https://mailgate.example.com npx -y mailgate-sdk otp e2e-auth@example.com)
```

---

## REST API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Health check for CI `wait-on` and uptime checks |
| `GET` | `/api/config` | Public domain and strict-allowlist mode |
| `POST` | `/api/inbox/check` | Check if an address is allowlisted and password-locked |
| `POST` | `/api/inbox/open` | Authenticate an inbox (or admin account) and return `X-Inbox-Token` |
| `GET` | `/api/inbox/messages` | List messages (`?email=&since=&sender=&limit=`) |
| `GET` | `/api/inbox/latest-otp` | Return the latest `otpCode` and `verificationLink` (`?email=&since=&sender=`) |
| `GET` | `/api/inbox/messages/:id` | Read full sanitized HTML/text body plus attachment metadata (`attachments: [{ filename, mimeType, size }]`) and mark as read |
| `GET/POST` | `/api/admin/inboxes` | List or create allowlisted inboxes (`X-Admin-Token` or admin cookie) |
| `PATCH/DELETE` | `/api/admin/inboxes/:id` | Update label/status/password or delete inbox (`?delete_messages=true`) |
| `GET/DELETE` | `/api/admin/messages` | Inspect latest stored messages or clear by `?email=` |
| `POST` | `/api/admin/simulate` | Send a simulated RFC822 email through the ingest and OTP pipeline |

---

## Configuration (`wrangler.toml`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAIL_DOMAIN` | `example.com` | Primary domain shown in UI placeholders and Admin Panel |
| `STRICT_ALLOWLIST` | `"true"` | When `"true"`, rejects non-allowlisted recipients at SMTP ingest |
| `RETENTION_DAYS` | `"14"` | Daily Cron Trigger purges messages older than N days (`0` disables cleanup) |
| `ALLOW_SIMULATE` | `"true"` | Enables `POST /api/admin/simulate` (set `"false"` in locked-down production) |

Secrets (via `wrangler secret put` or local `.dev.vars`):
- `ADMIN_EMAIL`: Admin login email for stealth sign-in via the main form
- `ADMIN_TOKEN`: Admin password and `X-Admin-Token` header credential
- `SESSION_SECRET`: Random 32+ byte secret for HMAC-SHA256 session cookies and inbox tokens

---

## Development & Tests

```bash
npm run typecheck   # Strict TypeScript check
npm test            # Unit tests (OTP, HTML sanitizer, PBKDF2/HMAC crypto, ingest, SDK)
```

See [SECURITY.md](./SECURITY.md) for security notes and [CONTRIBUTING.md](./CONTRIBUTING.md) if you want to contribute.

## License

Released under the [MIT License](./LICENSE).
