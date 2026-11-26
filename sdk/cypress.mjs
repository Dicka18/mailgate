/**
 * Cypress commands for MailGate. Cypress is supplied by the user's test suite;
 * this module adds no runtime dependencies.
 */

import { MailGateClient } from './index.mjs';

/**
 * Register `cy.waitForOtp()` and `cy.waitForEmail()` commands.
 *
 * @param {{ env?: (name: string) => unknown; Commands: { add: (name: string, command: Function) => void } }} Cypress
 * @param {{ baseUrl?: string; adminToken?: string; defaultEmail?: string; defaultPassword?: string }} [options]
 */
export function addMailGateCommands(Cypress, options = {}) {
  const baseUrl = options.baseUrl ?? Cypress.env?.('MAILGATE_URL') ?? process.env.MAILGATE_URL;
  const adminToken = options.adminToken ?? Cypress.env?.('MAILGATE_ADMIN_TOKEN') ?? process.env.MAILGATE_ADMIN_TOKEN;
  if (!baseUrl) {
    throw new Error('addMailGateCommands requires `options.baseUrl` or MAILGATE_URL.');
  }

  const client = new MailGateClient({ baseUrl, adminToken });
  const withDefaults = (method) => (query = {}) => {
    const email = query.email ?? options.defaultEmail;
    if (!email) {
      throw new Error(`${method} requires \`email\` (or set \`defaultEmail\` when registering commands).`);
    }
    return client[method]({
      ...query,
      email,
      password: query.password ?? options.defaultPassword,
    });
  };

  Cypress.Commands.add('waitForOtp', withDefaults('waitForOtp'));
  Cypress.Commands.add('waitForEmail', withDefaults('waitForEmail'));
}
