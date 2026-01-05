import { describe, it, expect } from "vitest";
import {
  generateSecondarySecret,
  isValidSecondarySecret,
  generatePlayerId,
  isValidPlayerId,
  deriveEncryptionKey,
  encryptHistory,
  decryptHistory,
} from "./nostr-crypto";
import type { HistoryEntry } from "./history";

describe("generateSecondarySecret", () => {
  it("generates a 16-character string", () => {
    const secret = generateSecondarySecret();
    expect(secret).toHaveLength(16);
  });

  it("generates URL-safe base64 (no +, /, or =)", () => {
    for (let i = 0; i < 100; i++) {
      const secret = generateSecondarySecret();
      expect(secret).not.toMatch(/[+/=]/);
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("generates unique secrets", () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      secrets.add(generateSecondarySecret());
    }
    expect(secrets.size).toBe(1000);
  });

  it("generates secrets that pass validation", () => {
    for (let i = 0; i < 100; i++) {
      const secret = generateSecondarySecret();
      expect(isValidSecondarySecret(secret)).toBe(true);
    }
  });
});

describe("isValidSecondarySecret", () => {
  it("returns true for valid generated secrets", () => {
    const secret = generateSecondarySecret();
    expect(isValidSecondarySecret(secret)).toBe(true);
  });

  it("returns false for wrong length strings", () => {
    expect(isValidSecondarySecret("")).toBe(false);
    expect(isValidSecondarySecret("abc")).toBe(false);
    expect(isValidSecondarySecret("abcdefghijklmno")).toBe(false); // 15 chars
    expect(isValidSecondarySecret("abcdefghijklmnopq")).toBe(false); // 17 chars
  });

  it("returns false for non-string values", () => {
    expect(isValidSecondarySecret(null as unknown as string)).toBe(false);
    expect(isValidSecondarySecret(undefined as unknown as string)).toBe(false);
    expect(isValidSecondarySecret(123 as unknown as string)).toBe(false);
    expect(isValidSecondarySecret({} as unknown as string)).toBe(false);
  });

  it("returns false for invalid base64 characters", () => {
    expect(isValidSecondarySecret("!!!!!!!!!!!!!!!!")).toBe(false); // 16 invalid chars
  });

  it("detects single character typos (checksum validation)", () => {
    const secret = generateSecondarySecret();
    const chars = secret.split("");

    // Flip one character and verify checksum fails
    let typoDetected = 0;
    for (let i = 0; i < chars.length; i++) {
      const modified = [...chars];
      // Change to a different valid base64 character
      modified[i] = modified[i] === "A" ? "B" : "A";
      const tamperedSecret = modified.join("");
      if (!isValidSecondarySecret(tamperedSecret)) {
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
      const secret = generateSecondarySecret();
      const chars = secret.split("");
      // Swap adjacent characters
      if (chars[0] !== chars[1]) {
        [chars[0], chars[1]] = [chars[1], chars[0]];
        const swapped = chars.join("");
        if (!isValidSecondarySecret(swapped)) {
          detected++;
        }
      }
    }
    // Most transpositions should be detected
    expect(detected).toBeGreaterThanOrEqual(45);
  });
});

describe("generatePlayerId", () => {
  it("generates a 43-character URL-safe base64 string", () => {
    const playerId = generatePlayerId();
    expect(playerId).toHaveLength(43);
    expect(playerId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates unique player IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generatePlayerId());
    }
    expect(ids.size).toBe(100);
  });

  it("generates player IDs that pass validation", () => {
    for (let i = 0; i < 100; i++) {
      const playerId = generatePlayerId();
      expect(isValidPlayerId(playerId)).toBe(true);
    }
  });
});

describe("isValidPlayerId", () => {
  it("returns true for valid generated player IDs", () => {
    const playerId = generatePlayerId();
    expect(isValidPlayerId(playerId)).toBe(true);
  });

  it("returns false for wrong length strings", () => {
    expect(isValidPlayerId("")).toBe(false);
    expect(isValidPlayerId("abc")).toBe(false);
    expect(isValidPlayerId("a".repeat(42))).toBe(false); // 42 chars
    expect(isValidPlayerId("a".repeat(44))).toBe(false); // 44 chars
  });

  it("returns false for non-URL-safe-base64 characters", () => {
    expect(isValidPlayerId("+".repeat(43))).toBe(false); // + is not URL-safe
    expect(isValidPlayerId("/".repeat(43))).toBe(false); // / is not URL-safe
    expect(isValidPlayerId("=".repeat(43))).toBe(false); // = is padding
  });

  it("returns false for non-string values", () => {
    expect(isValidPlayerId(null as unknown as string)).toBe(false);
    expect(isValidPlayerId(undefined as unknown as string)).toBe(false);
    expect(isValidPlayerId(123 as unknown as string)).toBe(false);
  });
});

describe("deriveEncryptionKey", () => {
  it("derives consistent keys from the same player ID", async () => {
    const playerId = generatePlayerId();
    const keys1 = await deriveEncryptionKey(playerId);
    const keys2 = await deriveEncryptionKey(playerId);

    expect(keys1.publicKey).toBe(keys2.publicKey);
    expect(keys1.privateKey).toEqual(keys2.privateKey);
  });

  it("derives different keys from different player IDs", async () => {
    const playerId1 = generatePlayerId();
    const playerId2 = generatePlayerId();
    const keys1 = await deriveEncryptionKey(playerId1);
    const keys2 = await deriveEncryptionKey(playerId2);

    expect(keys1.publicKey).not.toBe(keys2.publicKey);
  });

  it("produces valid 64-character hex public keys", async () => {
    const playerId = generatePlayerId();
    const keys = await deriveEncryptionKey(playerId);

    expect(keys.publicKey).toHaveLength(64);
    expect(keys.publicKey).toMatch(/^[0-9a-f]+$/);
  });

  it("produces 32-byte private keys", async () => {
    const playerId = generatePlayerId();
    const keys = await deriveEncryptionKey(playerId);

    expect(keys.privateKey).toBeInstanceOf(Uint8Array);
    expect(keys.privateKey.length).toBe(32);
  });

  it("throws on empty player ID", async () => {
    await expect(deriveEncryptionKey("")).rejects.toThrow("Player ID cannot be empty");
  });

  it("throws on invalid player ID format", async () => {
    await expect(deriveEncryptionKey("tooshort")).rejects.toThrow(
      "Invalid player ID format"
    );
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
    const playerId = generatePlayerId();
    const keys = await deriveEncryptionKey(playerId);
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
    const playerId1 = generatePlayerId();
    const playerId2 = generatePlayerId();
    const keys1 = await deriveEncryptionKey(playerId1);
    const keys2 = await deriveEncryptionKey(playerId2);

    const encrypted = encryptHistory(sampleHistory, keys1.publicKey);

    expect(() =>
      decryptHistory(
        encrypted.ciphertext,
        encrypted.ephemeralPubKey,
        keys2.privateKey
      )
    ).toThrow(/Decryption failed.*Wrong player ID/);
  });

  it("produces different ciphertext each time (ephemeral keys)", async () => {
    const playerId = generatePlayerId();
    const keys = await deriveEncryptionKey(playerId);

    const encrypted1 = encryptHistory(sampleHistory, keys.publicKey);
    const encrypted2 = encryptHistory(sampleHistory, keys.publicKey);

    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
    expect(encrypted1.ephemeralPubKey).not.toBe(encrypted2.ephemeralPubKey);
  });

  it("handles empty history array", async () => {
    const playerId = generatePlayerId();
    const keys = await deriveEncryptionKey(playerId);

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
