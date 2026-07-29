export function parseJsonObject(
  value: string | undefined,
  field: string,
): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${field} must contain valid JSON.`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function parseJsonValue(value: string | undefined, field: string): unknown {
  if (!value?.trim()) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${field} must contain valid JSON.`, { cause: error });
  }
}

export function formatJson(value: unknown, maxChars = 60_000): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(truncated ${text.length - maxChars} characters)`;
}
