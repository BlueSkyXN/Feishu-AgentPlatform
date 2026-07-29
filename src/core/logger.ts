type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

const SENSITIVE_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|app[_-]?secret|credential)/i;
const TOKEN_LIKE = /\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~-]{12,}|cli_[A-Za-z0-9]{10,})\b/gi;

export class Logger {
  constructor(private readonly base: LogFields = {}) {}

  child(fields: LogFields): Logger {
    return new Logger({ ...this.base, ...fields });
  }

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactString(message),
      ...sanitizeObject(this.base),
      ...sanitizeObject(normalizeFields(fields)),
    };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
      ...(error.cause ? { cause: String(error.cause) } : {}),
    };
  }
  return { errorMessage: String(error) };
}

export function redactString(value: string): string {
  return value.replace(TOKEN_LIKE, '[REDACTED]');
}

function normalizeFields(fields: LogFields): LogFields {
  const normalized: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    normalized[key] = value instanceof Error ? errorFields(value) : value;
  }
  return normalized;
}

function sanitizeObject(value: LogFields): LogFields {
  return sanitize(value) as LogFields;
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, '', depth + 1));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      result[childKey] = sanitize(childValue, childKey, depth + 1);
    }
    return result;
  }
  return value;
}
