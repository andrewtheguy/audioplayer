import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { encrypt, decrypt, getConversationKey } from "nostr-tools/nip44";
import { decode as decodeNip19, npubEncode, nsecEncode } from "nostr-tools/nip19";
import type { HistoryEntry, HistoryPayload } from "./history";

export interface NostrKeys {
  privateKey: Uint8Array;
  publicKey: string;
}

// Fixed salt for domain separation when deriving keys from player id
const PLAYER_ID_SALT = "audioplayer-playerid-v1";

// Secondary secret format: 11 random bytes + 1 checksum byte = 12 bytes → 16 base64 chars
const SECRET_RANDOM_BYTES = 11;
const SECRET_TOTAL_BYTES = 12;
const SECRET_LENGTH = 16;

// Player ID format: 32 random bytes → 64 hex chars
const PLAYER_ID_LENGTH = 64;

/**
 * CRC-8-CCITT lookup table (polynomial 0x07).
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

function computeChecksum(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc = CRC8_TABLE[crc ^ b];
  }
  return crc;
}

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// =============================================================================
// Player ID Functions
// =============================================================================

/**
 * Generate a new player id (32 random bytes, hex encoded = 64 chars)
 */
export function generatePlayerId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Validate player id format (64 hex characters)
 */
export function isValidPlayerId(playerId: string): boolean {
  return (
    typeof playerId === "string" &&
    playerId.length === PLAYER_ID_LENGTH &&
    /^[0-9a-f]+$/.test(playerId)
  );
}

// =============================================================================
// Secondary Secret Functions (for encrypting player id)
// =============================================================================

/**
 * Generate a random URL-safe Base64 secondary secret with checksum.
 */
export function generateSecondarySecret(): string {
  const randomBytes = new Uint8Array(SECRET_RANDOM_BYTES);
  crypto.getRandomValues(randomBytes);
  const checksum = computeChecksum(randomBytes);
  const allBytes = new Uint8Array(SECRET_TOTAL_BYTES);
  allBytes.set(randomBytes);
  allBytes[SECRET_RANDOM_BYTES] = checksum;
  return btoa(String.fromCharCode(...allBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Validate a secondary secret string has correct format and checksum.
 */
export function isValidSecondarySecret(secret: string): boolean {
  if (typeof secret !== "string" || secret.length !== SECRET_LENGTH) {
    return false;
  }
  const bytes = decodeUrlSafeBase64(secret);
  if (!bytes || bytes.length !== SECRET_TOTAL_BYTES) {
    return false;
  }
  const randomBytes = bytes.slice(0, SECRET_RANDOM_BYTES);
  const storedChecksum = bytes[SECRET_RANDOM_BYTES];
  const computedChecksum = computeChecksum(randomBytes);
  return storedChecksum === computedChecksum;
}

/**
 * Derive an AES-GCM key from secondary secret for symmetric encryption
 */
async function deriveAesKeyFromSecret(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const secretBytes = encoder.encode(secret);
  const saltBytes = encoder.encode("audioplayer-secondary-secret-v1");

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

  return crypto.subtle.importKey(
    "raw",
    derivedBits,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt data with secondary secret using AES-GCM
 */
export async function encryptWithSecondarySecret(
  data: string,
  secondarySecret: string
): Promise<string> {
  if (!isValidSecondarySecret(secondarySecret)) {
    throw new Error("Invalid secondary secret format");
  }

  const key = await deriveAesKeyFromSecret(secondarySecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(data);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    dataBytes
  );

  // Combine IV + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt data with secondary secret using AES-GCM
 */
export async function decryptWithSecondarySecret(
  ciphertext: string,
  secondarySecret: string
): Promise<string> {
  if (!isValidSecondarySecret(secondarySecret)) {
    throw new Error("Invalid secondary secret format");
  }

  const key = await deriveAesKeyFromSecret(secondarySecret);

  let combined: Uint8Array;
  try {
    const binary = atob(ciphertext);
    combined = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      combined[i] = binary.charCodeAt(i);
    }
  } catch {
    throw new Error("Invalid ciphertext format");
  }

  if (combined.length < 13) {
    throw new Error("Ciphertext too short");
  }

  const iv = combined.slice(0, 12);
  const encrypted = combined.slice(12);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      encrypted
    );
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch {
    throw new Error("Decryption failed - wrong secret?");
  }
}

// =============================================================================
// npub/nsec Functions
// =============================================================================

/**
 * Parse npub from URL hash and return hex public key, or null if invalid
 */
export function parseNpubFromHash(hash: string): string | null {
  const npub = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!npub || !npub.startsWith("npub1")) {
    return null;
  }
  try {
    const decoded = decodeNip19(npub);
    if (decoded.type !== "npub" || typeof decoded.data !== "string") {
      return null;
    }
    const pubkeyHex = decoded.data;
    if (pubkeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(pubkeyHex)) {
      return null;
    }
    return pubkeyHex;
  } catch {
    return null;
  }
}

/**
 * Validate npub format
 */
export function isValidNpub(npub: string): boolean {
  return parseNpubFromHash(npub) !== null;
}

/**
 * Decode nsec to get private key bytes, or null if invalid
 */
export function decodeNsec(nsec: string): Uint8Array | null {
  if (!nsec || !nsec.startsWith("nsec1")) {
    return null;
  }
  try {
    const decoded = decodeNip19(nsec);
    if (decoded.type === "nsec" && decoded.data instanceof Uint8Array && decoded.data.length === 32) {
      return decoded.data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Encode hex public key to npub
 */
export function encodeNpub(hexPubkey: string): string {
  if (hexPubkey.length !== 64 || !/^[0-9a-fA-F]+$/.test(hexPubkey)) {
    throw new Error("Invalid hex public key");
  }
  return npubEncode(hexPubkey);
}

/**
 * Generate a new nostr keypair and return as { nsec, npub, privateKey, publicKey }
 */
export function generateNostrKeypair(): {
  nsec: string;
  npub: string;
  privateKey: Uint8Array;
  publicKey: string;
} {
  const privateKey = generateSecretKey();
  const publicKey = getPublicKey(privateKey);
  const npub = npubEncode(publicKey);
  const nsec = nsecEncode(privateKey);
  return { nsec, npub, privateKey, publicKey };
}

// =============================================================================
// Key Derivation from Player ID
// =============================================================================

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

/**
 * Derive Nostr secp256k1 keypair from a player id using HKDF-SHA256.
 * This keypair is used for NIP-44 encryption of history data.
 */
export async function deriveEncryptionKey(
  playerId: string,
  signal?: AbortSignal
): Promise<NostrKeys> {
  if (!playerId) {
    throw new Error("Player ID cannot be empty");
  }
  if (!isValidPlayerId(playerId)) {
    throw new Error("Invalid player ID format");
  }
  throwIfAborted(signal);

  const playerIdBytes = hexToBytes(playerId);
  const encoder = new TextEncoder();
  const saltBytes = encoder.encode(PLAYER_ID_SALT);

  // Use slice to get a copy as ArrayBuffer (avoids SharedArrayBuffer type issues)
  const playerIdBuffer = playerIdBytes.buffer.slice(
    playerIdBytes.byteOffset,
    playerIdBytes.byteOffset + playerIdBytes.byteLength
  ) as ArrayBuffer;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    playerIdBuffer,
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

  let publicKey: string;
  try {
    publicKey = getPublicKey(privateKey);
  } catch {
    throw new Error("Derived key is invalid. Please generate a new player ID.");
  }

  return { privateKey, publicKey };
}

// =============================================================================
// History Encryption (using player id derived key)
// =============================================================================

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
 * Encrypt history data using NIP-44 with ephemeral sender key
 * Returns encrypted payload and ephemeral public key for decryption
 *
 * @param data - History entries to encrypt
 * @param recipientPublicKey - Public key derived from player id
 * @param sessionId - Optional session ID for multi-device coordination
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
 * Decrypt history data using NIP-44
 * Validates decryption, JSON parsing, and data structure
 *
 * @param ciphertext - Encrypted data
 * @param senderPublicKey - Ephemeral public key from encryption
 * @param recipientPrivateKey - Private key derived from player id
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
      `Decryption failed: ${err instanceof Error ? err.message : "Unknown error"}. Wrong player ID?`
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
