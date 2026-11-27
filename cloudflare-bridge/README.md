# MailGate Webhook Bridge (Optional)

Need to receive Cloudflare Email Routing messages on your own backend (Node.js, Go, Python, Rails, PHP, or Postgres/MySQL) instead of Cloudflare D1?

Deploy this standalone Worker as your catch-all Email Routing destination. It parses raw RFC822 MIME messages with `postal-mime` and forwards them as **HMAC-SHA256 signed JSON webhooks**.

## Setup

```bash
cd cloudflare-bridge
npm install
npx wrangler secret put INGEST_WEBHOOK_URL
npx wrangler secret put INGEST_SECRET
npm run deploy
```

Then in Cloudflare Dashboard → **Email Routing** → **Routing rules** → **Catch-all address**, send matching mail to the `mailgate-webhook-bridge` Worker.

## Webhook Contract

Every `POST` request sends:

- `Content-Type: application/json`
- `X-Ingest-Timestamp`: Unix timestamp in seconds
- `X-Ingest-Signature`: Hex-encoded `HMAC-SHA256(INGEST_SECRET, "${timestamp}.${rawBody}")`

```json
{
  "to": "otp@example.com",
  "from": "no-reply@github.com",
  "from_name": "GitHub Security",
  "subject": "Your verification code: 849201",
  "body_text": "...",
  "body_html": "..."
}
```

### Verifying the Signature (Node.js)

```js
import { verifyMailGateWebhook } from 'mailgate-sdk';

const rawBody = await request.text();
const isValid = await verifyMailGateWebhook({
  rawBody,
  signature: request.headers.get('X-Ingest-Signature') ?? '',
  timestamp: request.headers.get('X-Ingest-Timestamp') ?? '',
  secret: process.env.MAILGATE_INGEST_SECRET,
});

if (!isValid) throw new Error('Invalid MailGate webhook signature');
const payload = JSON.parse(rawBody);
```

Read the raw body before parsing JSON so it matches the signed payload.

If your webhook responds with HTTP `403`, the Worker rejects the email at the SMTP layer via `message.setReject(...)`.
