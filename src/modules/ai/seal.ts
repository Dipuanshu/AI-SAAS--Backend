import crypto from 'crypto';

// Secrets that must pass through the SaaS to the connector (a user's software password) are encrypted with a key only
// the SaaS and that company's connector know (the connector key), so they are never stored in plaintext in the queue.
const keyFrom = (connectorKey: string) => crypto.createHash('sha256').update(`seal:${connectorKey}`).digest();

export function seal(connectorKey: string, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(connectorKey), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function unseal(connectorKey: string, sealed: string): string {
  const buf = Buffer.from(sealed, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(connectorKey), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
