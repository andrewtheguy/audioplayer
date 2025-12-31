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

/**
 * Derive Nostr secp256k1 keypair from PIN using PBKDF2
 */
export async function deriveNostrKeysFromPin(pin: string): Promise<NostrKeys> {
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
  const publicKey = getPublicKey(privateKey);

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
 * Decrypt history data using NIP-44
 */
export function decryptHistory(
  ciphertext: string,
  senderPublicKey: string,
  recipientPrivateKey: Uint8Array
): HistoryEntry[] {
  const conversationKey = getConversationKey(recipientPrivateKey, senderPublicKey);
  const plaintext = decrypt(ciphertext, conversationKey);
  return JSON.parse(plaintext) as HistoryEntry[];
}
