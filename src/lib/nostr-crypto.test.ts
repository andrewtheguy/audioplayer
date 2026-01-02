import { describe, it, expect } from "vitest";
import {
  generateSecret,
  isValidSecret,
  deriveNostrKeys,
  encryptHistory,
  decryptHistory,
} from "./nostr-crypto";
import type { HistoryEntry } from "./history";

describe("generateSecret", () => {
  it("generates a 16-character string", () => {
    const secret = generateSecret();
    expect(secret).toHaveLength(16);
  });

  it("generates URL-safe base64 (no +, /, or =)", () => {
    for (let i = 0; i < 100; i++) {
      const secret = generateSecret();
      expect(secret).not.toMatch(/[+/=]/);
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("generates unique secrets", () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      secrets.add(generateSecret());
    }
    expect(secrets.size).toBe(1000);
  });

  it("generates secrets that pass validation", () => {
    for (let i = 0; i < 100; i++) {
      const secret = generateSecret();
      expect(isValidSecret(secret)).toBe(true);
    }
  });
});

describe("isValidSecret", () => {
  it("returns true for valid generated secrets", () => {
    const secret = generateSecret();
    expect(isValidSecret(secret)).toBe(true);
  });

  it("returns false for wrong length strings", () => {
    expect(isValidSecret("")).toBe(false);
    expect(isValidSecret("abc")).toBe(false);
    expect(isValidSecret("abcdefghijklmno")).toBe(false); // 15 chars
    expect(isValidSecret("abcdefghijklmnopq")).toBe(false); // 17 chars
  });

  it("returns false for non-string values", () => {
    expect(isValidSecret(null as unknown as string)).toBe(false);
    expect(isValidSecret(undefined as unknown as string)).toBe(false);
    expect(isValidSecret(123 as unknown as string)).toBe(false);
    expect(isValidSecret({} as unknown as string)).toBe(false);
  });

  it("returns false for invalid base64 characters", () => {
    expect(isValidSecret("!!!!!!!!!!!!!!!!")).toBe(false); // 16 invalid chars
  });

  it("detects single character typos (checksum validation)", () => {
    const secret = generateSecret();
    const chars = secret.split("");

    // Flip one character and verify checksum fails
    let typoDetected = 0;
    for (let i = 0; i < chars.length; i++) {
      const modified = [...chars];
      // Change to a different valid base64 character
      modified[i] = modified[i] === "A" ? "B" : "A";
      const tamperedSecret = modified.join("");
      if (!isValidSecret(tamperedSecret)) {
        typoDetected++;
      }
    }
    // Most single-character changes should be detected
    // (some may accidentally produce valid checksums, but very rare)
    expect(typoDetected).toBeGreaterThanOrEqual(14);
  });

  it("detects transposed characters", () => {
    let detected = 0;
    for (let trial = 0; trial < 50; trial++) {
      const secret = generateSecret();
      const chars = secret.split("");
      // Swap adjacent characters
      if (chars[0] !== chars[1]) {
        [chars[0], chars[1]] = [chars[1], chars[0]];
        const swapped = chars.join("");
        if (!isValidSecret(swapped)) {
          detected++;
        }
      }
    }
    // Most transpositions should be detected
    expect(detected).toBeGreaterThanOrEqual(45);
  });
});

describe("deriveNostrKeys", () => {
  it("derives consistent keys from the same secret", async () => {
    const secret = generateSecret();
    const keys1 = await deriveNostrKeys(secret);
    const keys2 = await deriveNostrKeys(secret);

    expect(keys1.publicKey).toBe(keys2.publicKey);
    expect(keys1.privateKey).toEqual(keys2.privateKey);
  });

  it("derives different keys from different secrets", async () => {
    const secret1 = generateSecret();
    const secret2 = generateSecret();
    const keys1 = await deriveNostrKeys(secret1);
    const keys2 = await deriveNostrKeys(secret2);

    expect(keys1.publicKey).not.toBe(keys2.publicKey);
  });

  it("produces valid 64-character hex public keys", async () => {
    const secret = generateSecret();
    const keys = await deriveNostrKeys(secret);

    expect(keys.publicKey).toHaveLength(64);
    expect(keys.publicKey).toMatch(/^[0-9a-f]+$/);
  });

  it("produces 32-byte private keys", async () => {
    const secret = generateSecret();
    const keys = await deriveNostrKeys(secret);

    expect(keys.privateKey).toBeInstanceOf(Uint8Array);
    expect(keys.privateKey.length).toBe(32);
  });

  it("throws on empty secret", async () => {
    await expect(deriveNostrKeys("")).rejects.toThrow("Secret cannot be empty");
  });
});

describe("encryptHistory / decryptHistory", () => {
  const sampleHistory: HistoryEntry[] = [
    {
      url: "https://example.com/audio.mp3",
      title: "Test Audio",
      lastPlayedAt: new Date().toISOString(),
      position: 123.45,
      gain: 0.8,
    },
    {
      url: "https://example.com/audio2.mp3",
      lastPlayedAt: new Date().toISOString(),
      position: 0,
    },
  ];

  it("round-trips history data correctly", async () => {
    const secret = generateSecret();
    const keys = await deriveNostrKeys(secret);
    const sessionId = "test-session-123";

    const encrypted = encryptHistory(sampleHistory, keys.publicKey, sessionId);

    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.ephemeralPubKey).toHaveLength(64);

    const decrypted = decryptHistory(
      encrypted.ciphertext,
      encrypted.ephemeralPubKey,
      keys.privateKey
    );

    expect(decrypted.history).toEqual(sampleHistory);
    expect(decrypted.sessionId).toBe(sessionId);
    expect(typeof decrypted.timestamp).toBe("number");
  });

  it("fails decryption with wrong private key", async () => {
    const secret1 = generateSecret();
    const secret2 = generateSecret();
    const keys1 = await deriveNostrKeys(secret1);
    const keys2 = await deriveNostrKeys(secret2);

    const encrypted = encryptHistory(sampleHistory, keys1.publicKey);

    expect(() =>
      decryptHistory(
        encrypted.ciphertext,
        encrypted.ephemeralPubKey,
        keys2.privateKey
      )
    ).toThrow(/Decryption failed.*Wrong Secret/);
  });

  it("produces different ciphertext each time (ephemeral keys)", async () => {
    const secret = generateSecret();
    const keys = await deriveNostrKeys(secret);

    const encrypted1 = encryptHistory(sampleHistory, keys.publicKey);
    const encrypted2 = encryptHistory(sampleHistory, keys.publicKey);

    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    expect(encrypted1.ephemeralPubKey).not.toBe(encrypted2.ephemeralPubKey);
  });

  it("handles empty history array", async () => {
    const secret = generateSecret();
    const keys = await deriveNostrKeys(secret);

    const encrypted = encryptHistory([], keys.publicKey);
    const decrypted = decryptHistory(
      encrypted.ciphertext,
      encrypted.ephemeralPubKey,
      keys.privateKey
    );

    expect(decrypted.history).toEqual([]);
  });

  it("rejects invalid public key format", () => {
    expect(() => encryptHistory(sampleHistory, "invalid")).toThrow(
      "Invalid recipient public key"
    );
    expect(() => encryptHistory(sampleHistory, "abc123")).toThrow(
      "Invalid recipient public key"
    );
  });
});
