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
 * CRC-8-CCITT lookup table (polynomial 0x07).
 * Provides stronger error detection than XOR or sum:
 * - Detects all single-bit errors
 * - Detects all double-bit errors
 * - Detects all odd numbers of bit errors
 * - Detects most burst errors
 */
const CRC8_TABLE = new Uint8Array([
  0x00, 0x07, 0x0e, 0x09, 0x1c, 0x1b, 0x12, 0x15,
  0x38, 0x3f, 0x36, 0x31, 0x24, 0x23, 0x2a, 0x2d,
  0x70, 0x77, 0x7e, 0x79, 0x6c, 0x6b, 0x62, 0x65,
  0x48, 0x4f, 0x46, 0x41, 0x54, 0x53, 0x5a, 0x5d,
  0xe0, 0xe7, 0xee, 0xe9, 0xfc, 0xfb, 0xf2, 0xf5,
  0xd8, 0xdf, 0xd6, 0xd1, 0xc4, 0xc3, 0xca, 0xcd,
  0x90, 0x97, 0x9e, 0x99, 0x8c, 0x8b, 0x82, 0x85,
  0xa8, 0xaf, 0xa6, 0xa1, 0xb4, 0xb3, 0xba, 0xbd,
  0xc7, 0xc0, 0xc9, 0xce, 0xdb, 0xdc, 0xd5, 0xd2,
  0xff, 0xf8, 0xf1, 0xf6, 0xe3, 0xe4, 0xed, 0xea,
  0xb7, 0xb0, 0xb9, 0xbe, 0xab, 0xac, 0xa5, 0xa2,
  0x8f, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9d, 0x9a,
  0x27, 0x20, 0x29, 0x2e, 0x3b, 0x3c, 0x35, 0x32,
  0x1f, 0x18, 0x11, 0x16, 0x03, 0x04, 0x0d, 0x0a,
  0x57, 0x50, 0x59, 0x5e, 0x4b, 0x4c, 0x45, 0x42,
  0x6f, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7d, 0x7a,
  0x89, 0x8e, 0x87, 0x80, 0x95, 0x92, 0x9b, 0x9c,
  0xb1, 0xb6, 0xbf, 0xb8, 0xad, 0xaa, 0xa3, 0xa4,
  0xf9, 0xfe, 0xf7, 0xf0, 0xe5, 0xe2, 0xeb, 0xec,
  0xc1, 0xc6, 0xcf, 0xc8, 0xdd, 0xda, 0xd3, 0xd4,
  0x69, 0x6e, 0x67, 0x60, 0x75, 0x72, 0x7b, 0x7c,
  0x51, 0x56, 0x5f, 0x58, 0x4d, 0x4a, 0x43, 0x44,
  0x19, 0x1e, 0x17, 0x10, 0x05, 0x02, 0x0b, 0x0c,
  0x21, 0x26, 0x2f, 0x28, 0x3d, 0x3a, 0x33, 0x34,
  0x4e, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5c, 0x5b,
  0x76, 0x71, 0x78, 0x7f, 0x6a, 0x6d, 0x64, 0x63,
  0x3e, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2c, 0x2b,
  0x06, 0x01, 0x08, 0x0f, 0x1a, 0x1d, 0x14, 0x13,
  0xae, 0xa9, 0xa0, 0xa7, 0xb2, 0xb5, 0xbc, 0xbb,
  0x96, 0x91, 0x98, 0x9f, 0x8a, 0x8d, 0x84, 0x83,
  0xde, 0xd9, 0xd0, 0xd7, 0xc2, 0xc5, 0xcc, 0xcb,
  0xe6, 0xe1, 0xe8, 0xef, 0xfa, 0xfd, 0xf4, 0xf3,
]);

/**
 * Compute CRC-8-CCITT checksum (polynomial 0x07).
 * Uses table lookup for efficiency.
 */
function computeChecksum(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc = CRC8_TABLE[crc ^ b];
  }
  return crc;
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
