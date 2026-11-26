/**
 * @mailgate/sdk — Zero-dependency client for MailGate self-hosted OTP & email inboxes.
 * Designed for Playwright, Cypress, Vitest, Jest, and CI/CD authentication tests.
 */

export class MailGateError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} code
   * @param {unknown} [details]
   */
  constructor(message, status, code, details) {
    super(message);
    this.name = 'MailGateError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class MailGateTimeoutError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'MailGateTimeoutError';
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {Date | string | number | undefined} value
 * @returns {string | undefined}
 */
function normalizeSince(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return String(value);
}

export class MailGateClient {
  /**
   * @param {{ baseUrl: string; adminToken?: string; fetch?: typeof globalThis.fetch }} options
   */
  constructor(options) {
    if (!options?.baseUrl) {
      throw new Error('MailGateClient requires a non-empty `baseUrl`.');
    }
    let normalizedBase = String(options.baseUrl).trim();
    while (normalizedBase.endsWith('/')) {
      normalizedBase = normalizedBase.slice(0, -1);
    }
    this.baseUrl = normalizedBase;
    this.adminToken = options.adminToken?.trim() || undefined;
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    /** @type {Map<string, string>} */
    this._inboxTokens = new Map();
  }

  /**
   * @private
   * @param {string} path
   * @param {RequestInit} [init]
   */
  async _request(path, init = {}) {
    const headers = new Headers(init.headers || {});
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await this._fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    const payload = await res
      .json()
      .catch(() => ({ ok: false, error: { code: 'INVALID_JSON', message: `HTTP ${res.status}` } }));

    if (!res.ok || payload?.ok === false) {
      const code = payload?.error?.code || 'HTTP_ERROR';
      const message = payload?.error?.message || `MailGate request failed with HTTP ${res.status}`;
      throw new MailGateError(message, res.status, code, payload?.error);
    }

    return payload;
  }

  /**
   * @private
   * @param {string} email
   * @param {string} [password]
   * @param {boolean} [forceRefresh]
   */
  async _resolveInboxHeaders(email, password, forceRefresh = false) {
    const key = email.trim().toLowerCase();
    const headers = {};
    if (forceRefresh) {
      this._inboxTokens.delete(key);
    }
    let token = this._inboxTokens.get(key);
    if (!token && password) {
      const opened = await this.openInbox(key, password);
      token = opened.inboxToken || undefined;
    }
    if (token) {
      headers['X-Inbox-Token'] = token;
    }
    return headers;
  }

  /**
   * @private
   */
  _requireAdminHeaders() {
    if (!this.adminToken) {
      throw new Error('This operation requires `adminToken` in MailGateClient options.');
    }
    return { 'X-Admin-Token': this.adminToken };
  }

  /**
   * Checks worker availability (`GET /api/health`).
   */
  async health() {
    return this._request('/api/health', { method: 'GET' });
  }

  /**
   * Checks whether an inbox is allowlisted and password-protected.
   * @param {string} email
   */
  async checkInbox(email) {
    return this._request('/api/inbox/check', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  /**
   * Opens an inbox and caches its signed X-Inbox-Token if password-protected.
   * @param {string} email
   * @param {string} [password]
   */
  async openInbox(email, password = '') {
    const res = await this._request('/api/inbox/open', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (res.inboxToken) {
      this._inboxTokens.set(email.trim().toLowerCase(), res.inboxToken);
    }
    return res;
  }

  /**
   * Lists messages for an inbox.
   * @param {{ email: string; password?: string; since?: Date | string | number; sender?: string; limit?: number }} options
   */
  async listMessages(options) {
    const qs = new URLSearchParams({ email: options.email });
    const sinceIso = normalizeSince(options.since);
    if (sinceIso) qs.set('since', sinceIso);
    if (options.sender) qs.set('sender', options.sender);
    if (options.limit) qs.set('limit', String(options.limit));

    const headers = await this._resolveInboxHeaders(options.email, options.password);
    const res = await this._request(`/api/inbox/messages?${qs.toString()}`, {
      method: 'GET',
      headers,
    });
    return res.messages;
  }

  /**
   * Reads a single full message (HTML, plain text, otp_code, verification_link).
   * @param {string} messageId
   * @param {{ email: string; password?: string }} options
   */
  async getMessage(messageId, options) {
    const headers = await this._resolveInboxHeaders(options.email, options.password);
    const res = await this._request(`/api/inbox/messages/${encodeURIComponent(messageId)}`, {
      method: 'GET',
      headers,
    });
    return res.message;
  }

  /**
   * Fetches the newest extracted OTP and verification link without polling.
   * @param {{ email: string; password?: string; since?: Date | string | number; sender?: string }} options
   */
  async getLatestOtp(options) {
    const qs = new URLSearchParams({ email: options.email });
    const sinceIso = normalizeSince(options.since);
    if (sinceIso) qs.set('since', sinceIso);
    if (options.sender) qs.set('sender', options.sender);

    const headers = await this._resolveInboxHeaders(options.email, options.password);
    return this._request(`/api/inbox/latest-otp?${qs.toString()}`, {
      method: 'GET',
      headers,
    });
  }

  /**
   * Polls until an OTP code arrives for the target inbox (ideal for Playwright/Cypress).
   * @param {{
   *   email: string;
   *   password?: string;
   *   since?: Date | string | number;
   *   sender?: string;
   *   timeoutMs?: number;
   *   pollIntervalMs?: number;
   *   signal?: AbortSignal;
   * }} options
   */
  async waitForOtp(options) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_500;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('waitForOtp aborted');
      }

      const result = await this.getLatestOtp({
        email: options.email,
        password: options.password,
        since: options.since,
        sender: options.sender,
      });

      if (result.found && result.otpCode) {
        return result;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new MailGateTimeoutError(
          `Timed out after ${timeoutMs}ms waiting for an OTP in ${options.email}`
        );
      }

      await sleep(Math.min(pollIntervalMs, remaining), options.signal);
    }
  }

  /**
   * Polls until a matching email arrives and returns the full message payload
   * (including `body_text`, `body_html`, `otp_code`, and `verification_link`).
   * @param {{
   *   email: string;
   *   password?: string;
   *   since?: Date | string | number;
   *   sender?: string;
   *   subjectIncludes?: string;
   *   timeoutMs?: number;
   *   pollIntervalMs?: number;
   *   signal?: AbortSignal;
   * }} options
   */
  async waitForEmail(options) {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 1_500;
    const deadline = Date.now() + timeoutMs;
    const subjectNeedle = options.subjectIncludes?.toLowerCase() || '';

    while (true) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('waitForEmail aborted');
      }

      const list = await this.listMessages({
        email: options.email,
        password: options.password,
        since: options.since,
        sender: options.sender,
        limit: 20,
      });

      const match = subjectNeedle
        ? list.find((m) => (m.subject || '').toLowerCase().includes(subjectNeedle))
        : list[0];

      if (match) {
        return this.getMessage(match.id, {
          email: options.email,
          password: options.password,
        });
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new MailGateTimeoutError(
          `Timed out after ${timeoutMs}ms waiting for a matching email in ${options.email}`
        );
      }

      await sleep(Math.min(pollIntervalMs, remaining), options.signal);
    }
  }

  // --- Admin Helpers (require `adminToken`) ---

  /**
   * Creates an allowlisted inbox (`POST /api/admin/inboxes`).
   * @param {{ email_address: string; label?: string; password?: string; is_active?: boolean }} input
   */
  async createInbox(input) {
    return this._request('/api/admin/inboxes', {
      method: 'POST',
      headers: this._requireAdminHeaders(),
      body: JSON.stringify(input),
    });
  }

  /**
   * Deletes an allowlisted inbox (`DELETE /api/admin/inboxes/:id`).
   * @param {number} inboxId
   * @param {{ deleteMessages?: boolean }} [options]
   */
  async deleteInbox(inboxId, options = {}) {
    const qs = options.deleteMessages ? '?delete_messages=true' : '';
    return this._request(`/api/admin/inboxes/${inboxId}${qs}`, {
      method: 'DELETE',
      headers: this._requireAdminHeaders(),
    });
  }

  /**
   * Purges all stored messages for an inbox (`DELETE /api/admin/messages?email=...`).
   * Useful in `beforeEach` hooks for deterministic CI runs.
   * @param {string} email
   */
  async clearMessages(email) {
    const qs = new URLSearchParams({ email });
    return this._request(`/api/admin/messages?${qs.toString()}`, {
      method: 'DELETE',
      headers: this._requireAdminHeaders(),
    });
  }

  /**
   * Injects a simulated RFC822 message through the live MIME + OTP pipeline (`POST /api/admin/simulate`).
   * @param {{ to: string; from?: string; from_name?: string; subject?: string; body_text?: string; body_html?: string }} input
   */
  async simulateEmail(input) {
    return this._request('/api/admin/simulate', {
      method: 'POST',
      headers: this._requireAdminHeaders(),
      body: JSON.stringify(input),
    });
  }
}
