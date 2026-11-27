#!/usr/bin/env node
/**
 * MailGate MCP Server (stdio JSON-RPC 2.0, zero external dependencies).
 * Lets Claude Code, Cursor, Windsurf, and other MCP clients read OTP codes
 * and verification links from a self-hosted MailGate instance during E2E testing.
 *
 * Environment variables:
 *   MAILGATE_URL         Base URL of your MailGate Worker (e.g. https://mailgate.example.com)
 *   MAILGATE_ADMIN_TOKEN Optional admin token for create_inbox, clear_messages, simulate_email
 */

import readline from 'node:readline';
import { MailGateClient, MailGateError, MailGateTimeoutError } from './index.mjs';

const SERVER_INFO = {
  name: 'mailgate-mcp',
  version: '1.1.0',
};

const SUPPORTED_PROTOCOL_VERSION = '2024-11-05';

function parseCliFlags(argv) {
  let baseUrl = process.env.MAILGATE_URL || '';
  let adminToken = process.env.MAILGATE_ADMIN_TOKEN || '';
  for (let i = 0; i < argv.length; i += 1) {
    if ((argv[i] === '--url' || argv[i] === '-u') && argv[i + 1]) {
      baseUrl = argv[++i];
    } else if ((argv[i] === '--admin-token' || argv[i] === '-t') && argv[i + 1]) {
      adminToken = argv[++i];
    }
  }
  return { baseUrl: baseUrl.trim(), adminToken: adminToken.trim() || undefined };
}

const TOOLS = [
  {
    name: 'mailgate_health',
    description: 'Check whether the configured MailGate Worker is reachable and healthy.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'mailgate_wait_for_otp',
    description:
      'Poll a MailGate inbox until a verification/OTP code arrives. Pass `since` (ISO timestamp) to ignore stale OTPs from earlier tests.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Recipient inbox address (e.g. qa-login@example.com).' },
        password: { type: 'string', description: 'Optional inbox password if the inbox is locked.' },
        since: { type: 'string', description: 'ISO 8601 timestamp; only consider emails received at or after this time.' },
        sender: { type: 'string', description: 'Optional substring filter on sender address (e.g. github.com).' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds (default: 30000).' },
        pollIntervalMs: { type: 'number', description: 'Polling interval in milliseconds (default: 1500).' },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },
  {
    name: 'mailgate_wait_for_email',
    description:
      'Poll a MailGate inbox until a matching email arrives and return its subject, text body, OTP code, and extracted magic/verification link.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Recipient inbox address.' },
        password: { type: 'string', description: 'Optional inbox password if locked.' },
        since: { type: 'string', description: 'ISO 8601 timestamp filter.' },
        sender: { type: 'string', description: 'Optional sender address substring filter.' },
        subjectIncludes: { type: 'string', description: 'Optional case-insensitive subject substring filter.' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds (default: 30000).' },
        pollIntervalMs: { type: 'number', description: 'Polling interval in milliseconds (default: 1500).' },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },
  {
    name: 'mailgate_list_messages',
    description: 'List recent messages stored in a MailGate inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Recipient inbox address.' },
        password: { type: 'string', description: 'Optional inbox password if locked.' },
        since: { type: 'string', description: 'Optional ISO 8601 timestamp filter.' },
        sender: { type: 'string', description: 'Optional sender address substring filter.' },
        limit: { type: 'number', description: 'Max number of messages to return (1-100, default: 20).' },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },
  {
    name: 'mailgate_get_message',
    description: 'Read a full stored message by ID, including attachment metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Recipient inbox address.' },
        messageId: { type: 'string', description: 'Message ID returned by mailgate_list_messages.' },
        password: { type: 'string', description: 'Optional inbox password if the inbox is locked.' },
      },
      required: ['email', 'messageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'mailgate_create_inbox',
    description: 'Allowlist a new inbox address on MailGate (requires MAILGATE_ADMIN_TOKEN).',
    inputSchema: {
      type: 'object',
      properties: {
        email_address: { type: 'string', description: 'Email address to allowlist.' },
        label: { type: 'string', description: 'Optional descriptive label.' },
        password: { type: 'string', description: 'Optional password (>= 4 chars) to lock the inbox.' },
      },
      required: ['email_address'],
      additionalProperties: false,
    },
  },
  {
    name: 'mailgate_clear_messages',
    description: 'Delete all stored messages for an inbox before starting a fresh test run (requires MAILGATE_ADMIN_TOKEN).',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Recipient inbox address to purge.' },
      },
      required: ['email'],
      additionalProperties: false,
    },
  },
  {
    name: 'mailgate_simulate_email',
    description:
      'Inject a simulated RFC822 message through the live MIME parser and OTP extractor (requires MAILGATE_ADMIN_TOKEN and ALLOW_SIMULATE=true).',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Allowlisted recipient inbox address.' },
        from: { type: 'string', description: 'Optional sender address.' },
        from_name: { type: 'string', description: 'Optional sender display name.' },
        subject: { type: 'string', description: 'Optional email subject (defaults to random OTP).' },
        body_text: { type: 'string', description: 'Optional plain-text body.' },
      },
      required: ['to'],
      additionalProperties: false,
    },
  },
];

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function toolResult(data, isError = false) {
  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Calls an MCP tool through the configured MailGate client.
 * @param {MailGateClient} client Configured MailGate SDK client.
 * @param {string} name MCP tool name.
 * @param {any} [args={}] Arguments supplied by the MCP client.
 * @returns {Promise<object>} MCP tool result.
 */
async function callTool(client, name, args = {}) {
  switch (name) {
    case 'mailgate_health':
      return toolResult(await client.health());

    case 'mailgate_wait_for_otp': {
      if (!args.email) return toolResult('Missing required argument: email', true);
      const res = await client.waitForOtp({
        email: String(args.email),
        password: args.password ? String(args.password) : undefined,
        since: args.since ? String(args.since) : undefined,
        sender: args.sender ? String(args.sender) : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000,
        pollIntervalMs: typeof args.pollIntervalMs === 'number' ? args.pollIntervalMs : 1_500,
      });
      return toolResult({
        otpCode: res.otpCode,
        verificationLink: res.verificationLink,
        message: res.message,
      });
    }

    case 'mailgate_wait_for_email': {
      if (!args.email) return toolResult('Missing required argument: email', true);
      const msg = await client.waitForEmail({
        email: String(args.email),
        password: args.password ? String(args.password) : undefined,
        since: args.since ? String(args.since) : undefined,
        sender: args.sender ? String(args.sender) : undefined,
        subjectIncludes: args.subjectIncludes ? String(args.subjectIncludes) : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 30_000,
        pollIntervalMs: typeof args.pollIntervalMs === 'number' ? args.pollIntervalMs : 1_500,
      });
      return toolResult({
        id: msg.id,
        sender: msg.sender,
        sender_name: msg.sender_name,
        subject: msg.subject,
        otp_code: msg.otp_code,
        verification_link: msg.verification_link,
        received_at: msg.received_at,
        body_text: msg.body_text,
      });
    }

    case 'mailgate_list_messages': {
      if (!args.email) return toolResult('Missing required argument: email', true);
      const messages = await client.listMessages({
        email: String(args.email),
        password: args.password ? String(args.password) : undefined,
        since: args.since ? String(args.since) : undefined,
        sender: args.sender ? String(args.sender) : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 20,
      });
      return toolResult({ count: messages.length, messages });
    }

    case 'mailgate_get_message': {
      if (!args.email) return toolResult('Missing required argument: email', true);
      if (!args.messageId) return toolResult('Missing required argument: messageId', true);
      const msg = await client.getMessage(String(args.messageId), {
        email: String(args.email),
        password: args.password ? String(args.password) : undefined,
      });
      return toolResult({
        id: msg.id,
        sender: msg.sender,
        sender_name: msg.sender_name,
        subject: msg.subject,
        otp_code: msg.otp_code,
        verification_link: msg.verification_link,
        received_at: msg.received_at,
        body_text: msg.body_text,
        attachments: msg.attachments,
      });
    }

    case 'mailgate_create_inbox': {
      if (!args.email_address) return toolResult('Missing required argument: email_address', true);
      return toolResult(
        await client.createInbox({
          email_address: String(args.email_address),
          label: args.label ? String(args.label) : undefined,
          password: args.password ? String(args.password) : undefined,
        })
      );
    }

    case 'mailgate_clear_messages': {
      if (!args.email) return toolResult('Missing required argument: email', true);
      return toolResult(await client.clearMessages(String(args.email)));
    }

    case 'mailgate_simulate_email': {
      if (!args.to) return toolResult('Missing required argument: to', true);
      return toolResult(
        await client.simulateEmail({
          to: String(args.to),
          from: args.from ? String(args.from) : undefined,
          from_name: args.from_name ? String(args.from_name) : undefined,
          subject: args.subject ? String(args.subject) : undefined,
          body_text: args.body_text ? String(args.body_text) : undefined,
        })
      );
    }

    default:
      return toolResult(`Unknown tool: ${name}`, true);
  }
}

export function startMcpServer(argv = process.argv.slice(2)) {
  const { baseUrl, adminToken } = parseCliFlags(argv);
  const client = baseUrl ? new MailGateClient({ baseUrl, adminToken }) : null;

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (rawLine) => {
    const line = rawLine.trim();
    if (!line) return;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      });
      return;
    }

    const { id, method, params } = req;

    // Notifications have no `id` and expect no response
    if (id === undefined || id === null) {
      return;
    }

    try {
      if (method === 'initialize') {
        const requestedVersion =
          typeof params?.protocolVersion === 'string'
            ? params.protocolVersion
            : SUPPORTED_PROTOCOL_VERSION;
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requestedVersion,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        });
        return;
      }

      if (method === 'ping') {
        writeMessage({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'tools/list') {
        writeMessage({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      }

      if (method === 'tools/call') {
        if (!client) {
          writeMessage({
            jsonrpc: '2.0',
            id,
            result: toolResult(
              'MAILGATE_URL is not set. Pass MAILGATE_URL env var or --url https://mailgate.example.com.',
              true
            ),
          });
          return;
        }
        const result = await callTool(client, params?.name, params?.arguments || {});
        writeMessage({ jsonrpc: '2.0', id, result });
        return;
      }

      writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (err) {
      if (err instanceof MailGateError || err instanceof MailGateTimeoutError) {
        writeMessage({
          jsonrpc: '2.0',
          id,
          result: toolResult(err.message, true),
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      writeMessage({
        jsonrpc: '2.0',
        id,
        result: toolResult(`MailGate MCP error: ${message}`, true),
      });
    }
  });
}

// Run when invoked directly as a binary (`mailgate-mcp` or `node sdk/mcp.mjs`)
const invokedDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith('mcp.mjs') || process.argv[1].includes('mailgate-mcp'));

if (invokedDirectly) {
  startMcpServer(process.argv.slice(2));
}
