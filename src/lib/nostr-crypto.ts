import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { encrypt, decrypt, getConversationKey } from "nostr-tools/nip44";
import { decode as decodeNip19 } from "nostr-tools/nip19";
import type { HistoryEntry, HistoryPayload } from "./history";

export interface NostrKeys {
  privateKey: Uint8Array;
  publicKey: string;
}

// Fixed salt for domain separation
const SALT = "audioplayer-secret-nostr-v1";

/**
 * Compute a simple checksum byte (XOR of all bytes).
 */
function computeChecksum(bytes: Uint8Array): number {
  let checksum = 0;
  for (const b of bytes) {
    checksum ^= b;
  }
  return checksum;
}

/**
 * Decode URL-safe Base64 to Uint8Array.
 */
function decodeUrlSafeBase64(str: string): Uint8Array | null {
  try {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Generate a random URL-safe Base64 secret with checksum.
 * Uses 11 bytes of entropy (88 bits) + 1 checksum byte, resulting in a 16-character string.
 * The checksum allows fail-fast validation of typos before attempting decryption.
 */
export function generateSecret(): string {
  const randomBytes = new Uint8Array(11);
  crypto.getRandomValues(randomBytes);
  const checksum = computeChecksum(randomBytes);
  const allBytes = new Uint8Array(12);
  allBytes.set(randomBytes);
  allBytes[11] = checksum;
  return btoa(String.fromCharCode(...allBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Validate a secret string has correct format and checksum.
 * Returns true if valid, false if checksum fails or format is invalid.
 */
export function isValidSecret(secret: string): boolean {
  if (typeof secret !== "string" || secret.length !== 16) {
    return false;
  }
  const bytes = decodeUrlSafeBase64(secret);
  if (!bytes || bytes.length !== 12) {
    return false;
  }
  const randomBytes = bytes.slice(0, 11);
  const storedChecksum = bytes[11];
  const computedChecksum = computeChecksum(randomBytes);
  return storedChecksum === computedChecksum;
}

/**
 * Derive Nostr secp256k1 keypair from a secret string using SHA-256.
 * Uses a fixed salt to prevent rainbow table attacks if secrets are leaked,
 * though the secrets themselves are high-entropy random strings.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

export async function deriveNostrKeys(
  secret: string,
  signal?: AbortSignal
): Promise<NostrKeys> {
  if (!secret) {
    throw new Error("Secret cannot be empty");
  }
  if (!isValidSecret(secret)) {
    throw new Error("Invalid secret format or checksum");
  }
  throwIfAborted(signal);

  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  const saltBytes = encoder.encode(SALT);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    "HKDF",
    false,
    ["deriveBits"]
  );
  throwIfAborted(signal);
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: saltBytes,
      info: new Uint8Array(0),
    },
    keyMaterial,
    256
  );
  throwIfAborted(signal);
  const privateKey = new Uint8Array(derivedBits);

  // Validate the derived key is a valid secp256k1 private key
  // by attempting to derive the public key
  let publicKey: string;
  try {
    publicKey = getPublicKey(privateKey);
  } catch {
    // Extremely rare case where hash output is invalid for secp256k1
    // (outside curve order). Practically negligible probability.
    throw new Error(
      "Derived key is invalid. Please generate a new secret."
    );
  }

  return { privateKey, publicKey };
}

/**
 * Encrypt history data using NIP-44 with ephemeral sender key
 * Returns encrypted payload and ephemeral public key for decryption
 */
export function encryptHistory(
  data: HistoryEntry[],
  recipientPublicKey: string,
  sessionId?: string
): { ciphertext: string; ephemeralPubKey: string } {
  if (
    typeof recipientPublicKey !== "string" ||
    recipientPublicKey.length !== 64 ||
    !/^[0-9a-fA-F]+$/.test(recipientPublicKey)
  ) {
    throw new Error("Invalid recipient public key.");
  }

  const ephemeralPrivKey = generateSecretKey();
  const ephemeralPubKey = getPublicKey(ephemeralPrivKey);

  const payload: HistoryPayload = {
    history: data,
    timestamp: Date.now(),
    sessionId,
  };

  const conversationKey = getConversationKey(ephemeralPrivKey, recipientPublicKey);
  const plaintext = JSON.stringify(payload);
  const ciphertext = encrypt(plaintext, conversationKey);
  ephemeralPrivKey.fill(0);

  return { ciphertext, ephemeralPubKey };
}

/**
 * Validate that a value is a valid HistoryEntry
 */
function isValidHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.url === "string" &&
    (entry.title === undefined || typeof entry.title === "string") &&
    typeof entry.lastPlayedAt === "string" &&
    typeof entry.position === "number" &&
    (entry.gain === undefined || typeof entry.gain === "number")
  );
}

/**
 * Validate that a parsed value is an array of valid HistoryEntry objects
 */
function validateHistoryArray(data: unknown): HistoryEntry[] {
  if (!Array.isArray(data)) {
    throw new Error("Decrypted data is not an array");
  }

  for (let i = 0; i < data.length; i++) {
    if (!isValidHistoryEntry(data[i])) {
      throw new Error(`Invalid history entry at index ${i}`);
    }
  }

  return data as HistoryEntry[];
}

function isValidHexPublicKey(value: string): boolean {
  return value.length === 64 && /^[0-9a-fA-F]+$/.test(value);
}

function decodeValidNpub(value: string): string | null {
  try {
    const decoded = decodeNip19(value);
    if (decoded.type !== "npub" || typeof decoded.data !== "string") {
      return null;
    }
    return isValidHexPublicKey(decoded.data) ? decoded.data : null;
  } catch {
    return null;
  }
}

/**
 * Validate that a parsed value is a valid HistoryPayload
 */
function validateHistoryPayload(data: unknown): HistoryPayload {
  if (typeof data !== "object" || data === null) {
    throw new Error("Payload is not an object");
  }

  const payload = data as Record<string, unknown>;

  if (typeof payload.timestamp !== "number") {
    throw new Error("Payload missing timestamp");
  }

  if (payload.sessionId !== undefined && typeof payload.sessionId !== "string") {
    throw new Error("Payload sessionId must be a string");
  }

  return {
    history: validateHistoryArray(payload.history),
    timestamp: payload.timestamp,
    sessionId: payload.sessionId as string | undefined,
  };
}

/**
 * Decrypt history data using NIP-44
 * Validates decryption, JSON parsing, and data structure
 */
export function decryptHistory(
  ciphertext: string,
  senderPublicKey: string,
  recipientPrivateKey: Uint8Array
): HistoryPayload {
  if (typeof senderPublicKey !== "string" || senderPublicKey.length === 0) {
    throw new Error("Invalid senderPublicKey: empty");
  }
  const isHexSender = isValidHexPublicKey(senderPublicKey);
  const decodedNpub = !isHexSender ? decodeValidNpub(senderPublicKey) : null;
  const isNpubSender = !isHexSender && decodedNpub !== null;
  if (!isHexSender && !isNpubSender) {
    throw new Error("Invalid senderPublicKey: expected 64-char hex or npub");
  }

  let senderHex = senderPublicKey;
  if (!isHexSender) {
    senderHex = decodedNpub!;
  }

  let plaintext: string;
  try {
    const conversationKey = getConversationKey(recipientPrivateKey, senderHex);
    plaintext = decrypt(ciphertext, conversationKey);
  } catch (err) {
    throw new Error(
      `Decryption failed: ${err instanceof Error ? err.message : "Unknown error"}. Wrong Secret?`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Decrypted data is not valid JSON. Data may be corrupted.");
  }

  try {
    return validateHistoryPayload(parsed);
  } catch (err) {
    throw new Error(
      `Invalid history data structure: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
