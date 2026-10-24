import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, parseKey } from "./crypto";

const key = randomBytes(32);

describe("crypto", () => {
  it("round-trips, including unicode and empty strings", () => {
    for (const s of ["", "secret-123", "ünïcødé 🔐"]) {
      expect(decrypt(encrypt(s, key), key)).toBe(s);
    }
  });
  it("uses a fresh IV each time", () => {
    expect(encrypt("a", key)).not.toBe(encrypt("a", key));
  });
  it("does not contain the plaintext", () => {
    expect(encrypt("hunter2hunter2", key)).not.toContain("hunter2");
  });
  it("rejects a wrong key", () => {
    expect(() => decrypt(encrypt("x", key), randomBytes(32))).toThrow();
  });
  it("rejects tampering", () => {
    const parts = encrypt("hello world", key).split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64");
    expect(() => decrypt(parts.join(":"), key)).toThrow();
  });
  it("rejects malformed payloads", () => {
    expect(() => decrypt("garbage", key)).toThrow();
  });
  it("parses base64 and hex keys, rejects bad ones", () => {
    expect(parseKey(key.toString("base64")).equals(key)).toBe(true);
    expect(parseKey(key.toString("hex")).equals(key)).toBe(true);
    expect(() => parseKey("short")).toThrow();
    expect(() => parseKey(undefined)).toThrow();
  });
});
