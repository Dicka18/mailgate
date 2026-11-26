import type { FullMessage, MailGateClient, WaitForEmailOptions, WaitForOtpOptions } from './index.d.ts';

export interface CypressCommandApi {
  env?(name: string): unknown;
  Commands: { add(name: string, command: (options?: Partial<WaitForOtpOptions | WaitForEmailOptions>) => unknown): void };
}

export interface AddMailGateCommandsOptions {
  baseUrl?: string;
  adminToken?: string;
  defaultEmail?: string;
  defaultPassword?: string;
}

export function addMailGateCommands(Cypress: CypressCommandApi, options?: AddMailGateCommandsOptions): void;

declare global {
  namespace Cypress {
    interface Chainable {
      waitForOtp(options?: Partial<WaitForOtpOptions>): Chainable<Awaited<ReturnType<MailGateClient['waitForOtp']>>>;
      waitForEmail(options?: Partial<WaitForEmailOptions>): Chainable<FullMessage>;
    }
  }
}
