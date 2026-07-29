import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export interface EncryptedEnvelope {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptJson(value: unknown, secret: string): EncryptedEnvelope {
  const key = deriveSecretKey(secret, 'encrypted-json');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export function decryptJson<T>(
  envelope: EncryptedEnvelope,
  secret: string,
): T {
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted data envelope.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveSecretKey(secret, 'encrypted-json'),
    Buffer.from(envelope.iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function deriveSecretKey(secret: string, purpose: string): Buffer {
  if (secret.length < 16) {
    throw new Error('Encryption secret must contain at least 16 characters.');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(purpose)) {
    throw new Error('Secret key purpose must be a safe identifier.');
  }
  return scryptSync(secret, `feishu-agent-platform:${purpose}:v1`, 32);
}
