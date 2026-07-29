const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;

/**
 * Normalize a configured HTTP callback path and reject representations that
 * can be interpreted differently by proxies, URL parsers, or routers.
 */
export function normalizeHttpPath(value: string, label = 'HTTP path'): string {
  const input = value.trim();
  if (!input || input.length > 512) {
    throw new Error(`${label} must contain 1 to 512 characters.`);
  }
  if (!input.startsWith('/') || input.startsWith('//')) {
    throw new Error(`${label} must start with exactly one slash.`);
  }
  if (
    input.includes('\\') ||
    input.includes('?') ||
    input.includes('#') ||
    CONTROL_CHARACTERS.test(input) ||
    MALFORMED_PERCENT_ESCAPE.test(input)
  ) {
    throw new Error(`${label} contains a prohibited character or escape.`);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch (error) {
    throw new Error(`${label} contains malformed percent encoding.`, {
      cause: error,
    });
  }
  if (
    decoded.includes('\\') ||
    decoded.includes('?') ||
    decoded.includes('#') ||
    decoded.includes('//') ||
    CONTROL_CHARACTERS.test(decoded)
  ) {
    throw new Error(`${label} decodes to an ambiguous or prohibited path.`);
  }

  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error(`${label} must not contain dot path segments.`);
  }

  const normalized = input.length > 1 ? input.replace(/\/+$/, '') : input;
  return normalized || '/';
}

/** Reject paths owned by the host control plane. */
export function assertAssignableHttpPath(
  value: string,
  label: string,
  options: { allowOAuthPrefix: boolean },
): void {
  const fixedRoutes = ['/', '/healthz', '/readyz', '/metrics'];
  const fixedPrefixes = ['/admin', '/api'];
  if (
    fixedRoutes.includes(value) ||
    fixedPrefixes.some(
      (prefix) => value === prefix || value.startsWith(`${prefix}/`),
    ) ||
    (!options.allowOAuthPrefix &&
      (value === '/oauth' || value.startsWith('/oauth/')))
  ) {
    throw new Error(`${label} conflicts with a control-plane route.`);
  }
}
