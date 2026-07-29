import type { HttpMethod, ReadOnlyOpenApiRule } from '../config/types.js';

const ENCODED_PATH_CONTROL = /%(?:00|0a|0d|2e|2f|5c)/i;

export function normalizeOpenApiPath(path: string): string {
  const value = path.trim();
  if (
    !value.startsWith('/open-apis/') ||
    value.length > 2_048 ||
    value.includes('..') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('\\') ||
    value.includes('//') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    ENCODED_PATH_CONTROL.test(value)
  ) {
    throw new Error('OpenAPI path must be a normalized /open-apis/ path.');
  }
  return value;
}

export function assertReadOnlyAllowed(
  method: HttpMethod,
  path: string,
  rules: ReadOnlyOpenApiRule[],
): void {
  if (method !== 'GET') {
    throw new Error(`Generic OpenAPI is read-only; ${method} is prohibited.`);
  }
  const normalized = normalizeOpenApiPath(path);
  const allowed = rules.some((rule) => {
    const prefix = normalizeOpenApiPath(rule.pathPrefix);
    return (
      normalized === prefix ||
      normalized.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
    );
  });
  if (!allowed) {
    throw new Error(`OpenAPI request denied by manifest policy: GET ${normalized}`);
  }
}

/** Backward-compatible internal alias. */
export const assertAllowed = assertReadOnlyAllowed;
