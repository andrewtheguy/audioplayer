import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { encrypt, decrypt, getConversationKey } from "nostr-tools/nip44";
import { decode as decodeNip19 } from "nostr-tools/nip19";
import type { HistoryEntry } from "./history";

export interface NostrKeys {
  privateKey: Uint8Array;
  publicKey: string;
}

// Fixed salt for domain separation
const SALT = "audioplayer-secret-nostr-v1";

/**
 * Generate a random URL-safe Base64 secret.
 * Uses 12 bytes of entropy (96 bits), resulting in a 16-character string.
 */
export function generateSecret(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Derive Nostr secp256k1 keypair from a secret string using SHA-256.
 * Uses a fixed salt to prevent rainbow table attacks if secrets are leaked,
 * though the secrets themselves are high-entropy random strings.
 */
export async function deriveNostrKeys(secret: string): Promise<NostrKeys> {
  if (!secret) {
    throw new Error("Secret cannot be empty");
  }

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
  recipientPublicKey: string
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

  const conversationKey = getConversationKey(ephemeralPrivKey, recipientPublicKey);
  const plaintext = JSON.stringify(data);
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

function isValidNpub(value: string): boolean {
  try {
    const decoded = decodeNip19(value);
    return decoded.type === "npub" && decoded.data instanceof Uint8Array;
  } catch {
    return false;
  }
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
  if (typeof senderPublicKey !== "string" || senderPublicKey.length === 0) {
    throw new Error("Invalid senderPublicKey: empty");
  }
  if (!isValidHexPublicKey(senderPublicKey) && !isValidNpub(senderPublicKey)) {
    throw new Error("Invalid senderPublicKey: expected 64-char hex or npub");
  }

  let plaintext: string;
  try {
    const conversationKey = getConversationKey(recipientPrivateKey, senderPublicKey);
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
    return validateHistoryArray(parsed);
  } catch (err) {
    throw new Error(
      `Invalid history data structure: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}
