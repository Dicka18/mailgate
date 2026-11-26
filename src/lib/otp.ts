/**
 * OTP & verification link extraction plus defensive HTML sanitization.
 */

const HTML_ENTITY_MAP: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
};

function decodeHtmlEntitiesOnce(input: string): string {
  return input.replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (match, key: string) => {
    const mapped = HTML_ENTITY_MAP[key.toLowerCase()];
    return mapped ?? match;
  });
}

function isTagNameDelimiter(ch: string | undefined): boolean {
  return ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch);
}

/**
 * Strips full `<tag ...>...</tag>` blocks using linear index scanning instead of
 * regex tag filters, handling whitespace or junk inside closing tags safely.
 */
function stripTagBlocks(html: string, tagNames: readonly string[], replacement: string): string {
  let current = html;
  for (let pass = 0; pass < 5; pass += 1) {
    const lower = current.toLowerCase();
    let changed = false;
    let cursor = 0;
    let out = '';

    while (cursor < current.length) {
      const lt = lower.indexOf('<', cursor);
      if (lt === -1) {
        out += current.slice(cursor);
        break;
      }

      let matchedTag: string | null = null;
      for (const tag of tagNames) {
        if (lower.startsWith(tag, lt + 1) && isTagNameDelimiter(lower[lt + 1 + tag.length])) {
          matchedTag = tag;
          break;
        }
      }

      if (!matchedTag) {
        out += current.slice(cursor, lt + 1);
        cursor = lt + 1;
        continue;
      }

      out += current.slice(cursor, lt) + replacement;
      changed = true;

      const openEnd = lower.indexOf('>', lt + 1 + matchedTag.length);
      if (openEnd === -1) {
        cursor = current.length;
        break;
      }

      // Scan forward for a matching `</tag ...>` closing tag
      const closePrefix = `</${matchedTag}`;
      let searchFrom = openEnd + 1;
      let closeEnd = -1;
      while (searchFrom < lower.length) {
        const closeStart = lower.indexOf(closePrefix, searchFrom);
        if (closeStart === -1) break;
        const afterName = closeStart + closePrefix.length;
        if (isTagNameDelimiter(lower[afterName])) {
          const gt = lower.indexOf('>', afterName);
          closeEnd = gt === -1 ? current.length : gt + 1;
          break;
        }
        searchFrom = afterName;
      }

      cursor = closeEnd === -1 ? openEnd + 1 : closeEnd;
    }

    current = out;
    if (!changed) break;
  }
  return current;
}

/**
 * Strips standalone/void dangerous tags (e.g. `<embed ...>`, `<meta ...>`) safely.
 */
function stripStandaloneTags(html: string, tagNames: readonly string[]): string {
  const lower = html.toLowerCase();
  let cursor = 0;
  let out = '';

  while (cursor < html.length) {
    const lt = lower.indexOf('<', cursor);
    if (lt === -1) {
      out += html.slice(cursor);
      break;
    }

    const isClosing = lower[lt + 1] === '/';
    const nameStart = isClosing ? lt + 2 : lt + 1;
    let matched = false;
    for (const tag of tagNames) {
      if (lower.startsWith(tag, nameStart) && isTagNameDelimiter(lower[nameStart + tag.length])) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      out += html.slice(cursor, lt + 1);
      cursor = lt + 1;
      continue;
    }

    out += html.slice(cursor, lt);
    const gt = lower.indexOf('>', nameStart);
    cursor = gt === -1 ? html.length : gt + 1;
  }

  return out;
}

/**
 * Removes all remaining HTML tags linearly without regex backtracking.
 */
function stripAllTags(html: string): string {
  let out = '';
  let inTag = false;
  for (let i = 0; i < html.length; i += 1) {
    const ch = html[i];
    if (ch === '<') {
      inTag = true;
      out += ' ';
    } else if (ch === '>') {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return out;
}

export function stripHtmlToText(html: string): string {
  if (!html) return '';
  let text = stripTagBlocks(html, ['style', 'script'], ' ');
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, '\n');
  text = stripAllTags(text);
  text = decodeHtmlEntitiesOnce(text);
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCKED_CONTAINER_TAGS = ['script', 'iframe', 'object', 'applet', 'form'] as const;
const BLOCKED_STANDALONE_TAGS = [
  'embed',
  'base',
  'meta',
  'link',
  'input',
  'textarea',
  'button',
  'frame',
  'frameset',
] as const;

export function sanitizeEmailHtml(html: string): string {
  if (!html) return '';
  let clean = html;
  for (let pass = 0; pass < 5; pass += 1) {
    const prev = clean;
    clean = stripTagBlocks(clean, BLOCKED_CONTAINER_TAGS, '');
    clean = stripStandaloneTags(clean, BLOCKED_STANDALONE_TAGS);
    clean = clean
      .replace(/[\s/]on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/@import\s+[^;]{0,512};/gi, '')
      .replace(/url\(\s*["']?\s*https?:\/\/[^)]{0,512}\)/gi, '')
      .replace(/expression\s*\([^)]{0,512}\)/gi, '')
      .replace(
        /(href|src|action|formaction)\s*=\s*(["'])\s*(?:javascript|vbscript|data\s*:\s*text\/html):[^"']{0,2048}\2/gi,
        '$1=$2#$2'
      );
    if (clean === prev) break;
  }
  return clean;
}

function isLikelyYear(code: string): boolean {
  if (code.length !== 4) return false;
  const n = Number(code);
  return n >= 1990 && n <= 2035;
}

export function extractOtpCode(subject: string, bodyText: string, bodyHtml = ''): string | null {
  const plainBody = bodyText?.trim() ? bodyText : stripHtmlToText(bodyHtml);
  const combined = `${subject}\n${plainBody}`;

  // 1. Explicit OTP / verification keyword patterns (English & Indonesian, linear-time regex)
  const keywordPatterns: RegExp[] = [
    /(?:verification\s+code|security\s+code|one-time\s+(?:code|passcode|password|token|pin)|login\s+(?:code|token)|confirmation\s+code|passcode|otp(?:\s+code)?|pin\s+code|kode\s+(?:verifikasi|otp|keamanan|masuk|login|konfirmasi))(?:[\s:=\-\u2013\u2014]{1,4}(?:is|are|adalah|yaitu|anda|your|berikut|ini)){0,3}[\s:=\-\u2013\u2014]{0,6}(\d{3}[-\s]\d{3}|\d{4,8})\b/i,
    /\b(\d{3}[-\s]\d{3}|\d{4,8})\b[^\n]{0,40}(?:is\s+your\s+(?:verification|security|login|otp|confirmation)|expires\s+in|adalah\s+kode|berlaku\s+selama)/i,
  ];

  for (const regex of keywordPatterns) {
    const match = combined.match(regex);
    if (match?.[1]) {
      const normalized = match[1].replace(/[-\s]/g, '');
      if (!isLikelyYear(normalized)) {
        return normalized;
      }
    }
  }

  // 2. 6-digit or 3-3 hyphenated code in the subject line
  const subjectSix = subject.match(/\b(\d{3}[-\s]\d{3}|\d{6})\b/);
  if (subjectSix?.[1]) {
    return subjectSix[1].replace(/[-\s]/g, '');
  }

  // 3. Standalone line containing 4-8 digits (common in transactional OTP templates)
  const standaloneLine = plainBody.match(/^\s*(\d{3}[-\s]\d{3}|\d{4,8})\s*$/m);
  if (standaloneLine?.[1]) {
    const normalized = standaloneLine[1].replace(/[-\s]/g, '');
    if (!isLikelyYear(normalized)) {
      return normalized;
    }
  }

  return null;
}

export function extractVerificationLink(bodyText: string, bodyHtml = ''): string | null {
  const sources = [bodyText || '', bodyHtml || ''];
  const urlRegex = /https?:\/\/[^\s"'<>()]+/gi;
  const priorityKeywords = /(verify|login|signin|sign-in|magic|confirm|auth|token|activate|callback|reset)/i;
  const ignoredDomains = /(unsubscribe|privacy|terms|twitter\.com|x\.com|facebook\.com|instagram\.com|linkedin\.com)/i;

  let fallbackUrl: string | null = null;
  for (const src of sources) {
    const matches = src.match(urlRegex) || [];
    for (const raw of matches) {
      const clean = raw.replace(/[.,;!?]+$/, '');
      if (ignoredDomains.test(clean)) {
        continue;
      }
      if (priorityKeywords.test(clean)) {
        return clean;
      }
      if (!fallbackUrl && clean.length > 24) {
        fallbackUrl = clean;
      }
    }
  }
  return fallbackUrl;
}

export function buildPreview(bodyText: string, bodyHtml: string, maxLength = 128): string {
  const raw = (bodyText?.trim() ? bodyText : stripHtmlToText(bodyHtml))
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return 'No message preview available.';
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength - 1).trimEnd()}…`;
}
