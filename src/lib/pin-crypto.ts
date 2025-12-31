import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { encrypt, decrypt, getConversationKey } from "nostr-tools/nip44";
import type { HistoryEntry } from "./history";

export interface NostrKeys {
  privateKey: Uint8Array;
  publicKey: string;
}

// Fixed salt for all users - intentional for deterministic key derivation.
// The same PIN must always produce the same Nostr keypair so users can
// recover their data on any device without storing anything locally.
// The salt provides domain separation (same PIN in different apps = different keys).
// Note: This is separate from the IV/nonce used in NIP-44 encryption, which is
// random for each encryption operation (providing semantic security).
const SALT = "audioplayer-pin-nostr-v1";
const ITERATIONS = 100000;

// PIN format: version prefix (1 char) + random data (12 chars) + checksum (1 char) = 14 chars
const PIN_LENGTH = 14;
const PIN_VERSION = "a"; // Version 1
const RANDOM_CHARS_LENGTH = 12;

// Alphanumeric character set for PIN generation and checksum
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Compute checksum character from data string.
 * Sum of ASCII codes mod 62, mapped to alphanumeric.
 */
function computeChecksum(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data.charCodeAt(i);
  }
  return ALPHANUMERIC[sum % 62];
}

/**
 * Generate a cryptographically random PIN.
 * Format: 'a' (version) + 12 random alphanumeric chars + 1 checksum char = 14 chars total
 */
export function generatePin(): string {
  const randomBytes = new Uint8Array(RANDOM_CHARS_LENGTH);
  crypto.getRandomValues(randomBytes);

  let randomPart = "";
  for (let i = 0; i < RANDOM_CHARS_LENGTH; i++) {
    randomPart += ALPHANUMERIC[randomBytes[i] % 62];
  }

  const dataWithoutChecksum = PIN_VERSION + randomPart;
  const checksum = computeChecksum(dataWithoutChecksum);

  return dataWithoutChecksum + checksum;
}

/**
 * Validate PIN format: version prefix, length, and checksum
 */
function validatePinFormat(pin: string): void {
  if (pin.length !== PIN_LENGTH) {
    throw new Error(`Invalid PIN: must be exactly ${PIN_LENGTH} characters`);
  }

  if (!pin.startsWith(PIN_VERSION)) {
    throw new Error(`Invalid PIN: unrecognized version`);
  }

  const dataWithoutChecksum = pin.slice(0, -1);
  const providedChecksum = pin.slice(-1);
  const expectedChecksum = computeChecksum(dataWithoutChecksum);

  if (providedChecksum !== expectedChecksum) {
    throw new Error("Invalid PIN: checksum mismatch (typo or corrupted)");
  }
}

/**
 * Derive Nostr secp256k1 keypair from PIN using PBKDF2
 * Validates PIN format and ensures derived key is valid for secp256k1
 */
export async function deriveNostrKeysFromPin(pin: string): Promise<NostrKeys> {
  validatePinFormat(pin);

  const encoder = new TextEncoder();
  const pinBytes = encoder.encode(pin);
  const saltBytes = encoder.encode(SALT);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    pinBytes,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );

  const privateKey = new Uint8Array(derivedBits);

  // Validate the derived key is a valid secp256k1 private key
  // by attempting to derive the public key (will throw if invalid)
  let publicKey: string;
  try {
    publicKey = getPublicKey(privateKey);
  } catch {
    // Extremely rare: derived bytes outside secp256k1 curve order
    throw new Error(
      "Derived key is invalid for secp256k1. Please use a different PIN."
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
  recipientPublicKey: string
): { ciphertext: string; ephemeralPubKey: string } {
  const ephemeralPrivKey = generateSecretKey();
  const ephemeralPubKey = getPublicKey(ephemeralPrivKey);

  const conversationKey = getConversationKey(ephemeralPrivKey, recipientPublicKey);
  const plaintext = JSON.stringify(data);
  const ciphertext = encrypt(plaintext, conversationKey);

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

/**
 * Decrypt history data using NIP-44
 * Validates decryption, JSON parsing, and data structure
 */
export function decryptHistory(
  ciphertext: string,
  senderPublicKey: string,
  recipientPrivateKey: Uint8Array
): HistoryEntry[] {
  let plaintext: string;
  try {
    const conversationKey = getConversationKey(recipientPrivateKey, senderPublicKey);
    plaintext = decrypt(ciphertext, conversationKey);
  } catch (err) {
    throw new Error(
      `Decryption failed: ${err instanceof Error ? err.message : "Unknown error"}. Wrong PIN?`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Decrypted data is not valid JSON. Data may be corrupted.");
  }

  try {
    return validateHistoryArray(parsed);
  } catch (err) {
    throw new Error(
      `Invalid history data structure: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
