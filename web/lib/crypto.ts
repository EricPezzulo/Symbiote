import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM envelope: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
// Key: ENCRYPTION_KEY env, 32 bytes as base64 (openssl rand -base64 32) or 64 hex chars.

const VERSION = "v1";

export function parseKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function isEncryptionConfigured(): boolean {
  try {
    parseKey(process.env.ENCRYPTION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function encrypt(plaintext: string, key: Buffer = parseKey(process.env.ENCRYPTION_KEY)): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(payload: string, key: Buffer = parseKey(process.env.ENCRYPTION_KEY)): string {
  const [version, iv, tag, ct] = payload.split(":");
  if (version !== VERSION || !iv || !tag || ct === undefined) {
    throw new Error("Unrecognised ciphertext format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  // Failure (wrong key / tampering) throws without revealing content.
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}
