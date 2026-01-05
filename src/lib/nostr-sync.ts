import { finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { HistoryEntry, HistoryPayload } from "./history";
import {
  encryptHistory,
  decryptHistory,
  encryptWithSecondarySecret,
  decryptWithSecondarySecret,
} from "./nostr-crypto";

export const RELAYS = [
  "wss://nos.lol",
  "wss://relay.nostr.net",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

const KIND_APP_DATA = 30078; // NIP-78: Application-specific replaceable data
const D_TAG_PLAYER_ID = "audioplayer-playerid-v1";
const D_TAG_HISTORY = "audioplayer-history-v1";

const pool = new SimplePool();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

/**
 * Close all relay connections to avoid resource leaks.
 */
let poolClosed = false;
export function closePool(): void {
  if (poolClosed) return;
  poolClosed = true;
  pool.close(RELAYS);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", closePool);
  window.addEventListener("pagehide", closePool);
}

/** Validated history payload structure from a Nostr event */
interface ValidatedHistoryPayload {
  v: number;
  ephemeralPubKey: string;
  ciphertext: string;
}

function isValidHistoryPayload(value: unknown): value is ValidatedHistoryPayload {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.v === "number" &&
    typeof obj.ephemeralPubKey === "string" &&
    typeof obj.ciphertext === "string"
  );
}

function parseAndValidateHistoryContent(content: string): ValidatedHistoryPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new Error("Event content is not valid JSON. Data may be corrupted.");
  }

  if (!isValidHistoryPayload(payload)) {
    throw new Error(
      "Invalid payload structure: missing or invalid ephemeralPubKey/ciphertext fields"
    );
  }

  return payload;
}

function canSetOnError(
  value: unknown
): value is { onerror?: (err: unknown) => void } {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { onerror?: unknown };
  return typeof maybe.onerror === "undefined" || typeof maybe.onerror === "function";
}

// =============================================================================
// Player ID Event Functions
// =============================================================================

/**
 * Check if a player id event exists for the given public key
 */
export async function checkPlayerIdEventExists(
  userPublicKey: string,
  signal?: AbortSignal
): Promise<boolean> {
  throwIfAborted(signal);
  const events = await pool.querySync(RELAYS, {
    kinds: [KIND_APP_DATA],
    authors: [userPublicKey],
    "#d": [D_TAG_PLAYER_ID],
    limit: 1,
  });
  throwIfAborted(signal);
  return events.length > 0;
}

/**
 * Fetch player id event from relays
 * Returns the encrypted player id content, or null if not found
 */
export async function fetchPlayerIdEventFromNostr(
  userPublicKey: string,
  signal?: AbortSignal
): Promise<{ encryptedPlayerId: string; createdAt: number } | null> {
  throwIfAborted(signal);
  const events = await pool.querySync(RELAYS, {
    kinds: [KIND_APP_DATA],
    authors: [userPublicKey],
    "#d": [D_TAG_PLAYER_ID],
    limit: 1,
  });
  throwIfAborted(signal);

  if (events.length === 0) {
    return null;
  }

  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  return {
    encryptedPlayerId: latest.content,
    createdAt: latest.created_at,
  };
}

/**
 * Fetch and decrypt player id from relays
 */
export async function loadPlayerIdFromNostr(
  userPublicKey: string,
  secondarySecret: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await fetchPlayerIdEventFromNostr(userPublicKey, signal);
  if (!result) {
    return null;
  }

  try {
    const playerId = await decryptWithSecondarySecret(
      result.encryptedPlayerId,
      secondarySecret
    );
    return playerId;
  } catch (err) {
    throw new Error(
      `Failed to decrypt player ID: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

/**
 * Publish player id event to relays
 * The player id is encrypted with the secondary secret before publishing
 * The event is signed with the user's nsec
 */
export async function publishPlayerIdToNostr(
  playerId: string,
  secondarySecret: string,
  userPrivateKey: Uint8Array,
  userPublicKey: string,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);

  // Encrypt player id with secondary secret
  const encryptedPlayerId = await encryptWithSecondarySecret(playerId, secondarySecret);

  const tags = [
    ["d", D_TAG_PLAYER_ID],
    ["client", "audioplayer"],
  ];

  const event = finalizeEvent(
    {
      kind: KIND_APP_DATA,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: encryptedPlayerId,
    },
    userPrivateKey
  );

  // Verify the event was signed by the expected public key
  if (event.pubkey !== userPublicKey) {
    throw new Error("Event signed by unexpected public key - nsec may not match npub");
  }

  try {
    throwIfAborted(signal);
    const publishPromises = pool.publish(RELAYS, event).map((promise, index) =>
      promise.catch((err) => {
        const relay = RELAYS[index] ?? "unknown relay";
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[nostr] player id publish failed on ${relay}: ${message}`);
        throw err;
      })
    );
    await Promise.any(publishPromises);
    throwIfAborted(signal);
  } catch (err) {
    if (err instanceof AggregateError) {
      const reasons = err.errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; ");
      throw new Error(`Failed to publish player ID to any relay: ${reasons}`);
    }
    throw new Error(
      `Failed to publish player ID: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

// =============================================================================
// History Event Functions
// =============================================================================

/**
 * Save encrypted history to Nostr relays.
 * History is encrypted and signed using keys derived from the player id.
 * This means history events are authored by the player id identity, not the npub.
 */
export async function saveHistoryToNostr(
  history: HistoryEntry[],
  encryptionKeys: { publicKey: string; privateKey: Uint8Array }, // Keys derived from player id
  sessionId?: string,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);

  // Encrypt history with the encryption key derived from player id
  const { ciphertext, ephemeralPubKey } = encryptHistory(
    history,
    encryptionKeys.publicKey,
    sessionId
  );

  const payload = JSON.stringify({
    v: 1,
    ephemeralPubKey,
    ciphertext,
  });

  const tags = [
    ["d", D_TAG_HISTORY],
    ["client", "audioplayer"],
  ];

  const event = finalizeEvent(
    {
      kind: KIND_APP_DATA,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: payload,
    },
    encryptionKeys.privateKey
  );

  try {
    throwIfAborted(signal);
    const publishPromises = pool.publish(RELAYS, event).map((promise, index) =>
      promise.catch((err) => {
        const relay = RELAYS[index] ?? "unknown relay";
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[nostr] history publish failed on ${relay}: ${message}`);
        throw err;
      })
    );
    await Promise.any(publishPromises);
    throwIfAborted(signal);
  } catch (err) {
    if (err instanceof AggregateError) {
      const reasons = err.errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; ");
      throw new Error(`Failed to publish history to any relay: ${reasons}`);
    }
    throw new Error(
      `Failed to save to Nostr: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

/**
 * Load and decrypt history from Nostr relays
 * History events are authored by the player id derived public key.
 */
export async function loadHistoryFromNostr(
  encryptionKeys: { publicKey: string; privateKey: Uint8Array }, // Keys derived from player id
  signal?: AbortSignal
): Promise<HistoryPayload | null> {
  throwIfAborted(signal);
  const events = await pool.querySync(RELAYS, {
    kinds: [KIND_APP_DATA],
    authors: [encryptionKeys.publicKey], // History events are authored by player id pubkey
    "#d": [D_TAG_HISTORY],
    limit: 1,
  });
  throwIfAborted(signal);

  if (events.length === 0) {
    return null;
  }

  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
  const payload = parseAndValidateHistoryContent(latest.content);

  return decryptHistory(
    payload.ciphertext,
    payload.ephemeralPubKey,
    encryptionKeys.privateKey
  );
}

/**
 * Subscribe to history updates with full payload decryption
 * History events are authored by the player id derived public key.
 */
export function subscribeToHistoryDetailed(
  encryptionKeys: { publicKey: string; privateKey: Uint8Array }, // Keys derived from player id
  onEvent: (payload: HistoryPayload) => void
): () => void {
  try {
    const sub = pool.subscribeMany(
      RELAYS,
      {
        kinds: [KIND_APP_DATA],
        authors: [encryptionKeys.publicKey], // History events are authored by player id pubkey
        "#d": [D_TAG_HISTORY],
      },
      {
        onevent: (event) => {
          try {
            const payload = parseAndValidateHistoryContent(event.content);
            const historyPayload = decryptHistory(
              payload.ciphertext,
              payload.ephemeralPubKey,
              encryptionKeys.privateKey
            );
            onEvent(historyPayload);
          } catch (err) {
            console.error("Nostr history event handler failed:", err);
          }
        },
      }
    );

    if (canSetOnError(sub)) {
      sub.onerror = (err) => {
        console.error("Nostr history subscription error:", err);
      };
    }

    return () => {
      sub.close();
    };
  } catch (err) {
    console.error("Failed to subscribe to Nostr history:", err);
    return () => {};
  }
}

// =============================================================================
// Merge Utilities
// =============================================================================

export interface MergeResult {
  merged: HistoryEntry[];
  addedFromCloud: number;
}

/**
 * Merge remote history into local history.
 * Remote is the source of truth for ordering, URLs, titles, and gain.
 * Local position is preserved only when local lastPlayedAt is newer for the same URL.
 */
export function mergeHistory(
  local: HistoryEntry[],
  remote: HistoryEntry[]
): MergeResult {
  const localByUrl = new Map(local.map((e) => [e.url, e]));

  let addedFromCloud = 0;

  const merged = remote.map((remoteEntry) => {
    const localEntry = localByUrl.get(remoteEntry.url);
    if (!localEntry) {
      addedFromCloud++;
      return remoteEntry;
    }

    const localTimeParsed = new Date(localEntry.lastPlayedAt).getTime();
    const remoteTimeParsed = new Date(remoteEntry.lastPlayedAt).getTime();

    const localTime = Number.isFinite(localTimeParsed) ? localTimeParsed : -Infinity;
    const remoteTime = Number.isFinite(remoteTimeParsed) ? remoteTimeParsed : -Infinity;

    if (localTime === -Infinity && remoteTime === -Infinity) {
      return remoteEntry;
    }

    if (localTime > remoteTime) {
      return { ...remoteEntry, position: localEntry.position };
    }

    return remoteEntry;
  });

  return {
    merged,
    addedFromCloud,
  };
}
