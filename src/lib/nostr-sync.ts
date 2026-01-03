import { finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { HistoryEntry, HistoryPayload } from "./history";
import { encryptHistory, decryptHistory } from "./nostr-crypto";

export const RELAYS = [
    'wss://nos.lol',
    //'wss://relay.damus.io', [nostr] publish failed on wss://relay.damus.io: rate-limited: you are noting too much
    'wss://relay.nostr.band',
    'wss://relay.nostr.net',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
];

const KIND_HISTORY = 30078; // NIP-78: Application-specific replaceable data
const D_TAG = "audioplayer-v3";

const pool = new SimplePool();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

/**
 * Close all relay connections to avoid resource leaks.
 * Call this during application shutdown or cleanup.
 */
let poolClosed = false;
export function closePool(): void {
  if (poolClosed) return;
  poolClosed = true;
  pool.close(RELAYS);
}

// Register cleanup handlers for browser environment
// Both handlers are registered since browser support varies;
// the poolClosed flag prevents duplicate cleanup calls.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", closePool);
  window.addEventListener("pagehide", closePool);
}

/** Validated payload structure from a Nostr event */
interface ValidatedPayload {
  v: number;
  ephemeralPubKey: string;
  ciphertext: string;
}

/**
 * Validate the encrypted payload structure from a Nostr event
 */
function isValidPayload(value: unknown): value is ValidatedPayload {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.v === "number" &&
    typeof obj.ephemeralPubKey === "string" &&
    typeof obj.ciphertext === "string"
  );
}

/**
 * Parse and validate event content JSON
 * Throws with descriptive error messages for catch blocks
 */
function parseAndValidateEventContent(content: string): ValidatedPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new Error("Event content is not valid JSON. Data may be corrupted.");
  }

  if (!isValidPayload(payload)) {
    throw new Error(
      "Invalid payload structure: missing or invalid ephemeralPubKey/ciphertext fields"
    );
  }

  return payload;
}

/**
 * Type guard for checking if subscription supports onerror handler
 */
function canSetOnError(
  value: unknown
): value is { onerror?: (err: unknown) => void } {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { onerror?: unknown };
  return typeof maybe.onerror === "undefined" || typeof maybe.onerror === "function";
}

/**
 * Save encrypted history to Nostr relays.
 * Throws descriptive error if all relays fail.
 */
export async function saveHistoryToNostr(
  history: HistoryEntry[],
  userPrivateKey: Uint8Array,
  userPublicKey: string,
  sessionId?: string,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  // sessionId and timestamp are now embedded in the encrypted payload
  const { ciphertext, ephemeralPubKey } = encryptHistory(history, userPublicKey, sessionId);

  const payload = JSON.stringify({
    v: 1,
    ephemeralPubKey,
    ciphertext,
  });

  const tags = [
    ["d", D_TAG],
    ["client", "audioplayer"],
  ];

  const event = finalizeEvent(
    {
      kind: KIND_HISTORY,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: payload,
    },
    userPrivateKey
  );

  try {
    throwIfAborted(signal);
    const publishPromises = pool.publish(RELAYS, event).map((promise, index) =>
      promise.catch((err) => {
        const relay = RELAYS[index] ?? "unknown relay";
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[nostr] publish failed on ${relay}: ${message}`);
        throw err;
      })
    );
    await Promise.any(publishPromises);
    throwIfAborted(signal);
  } catch (err) {
    // Promise.any throws AggregateError when all promises reject
    if (err instanceof AggregateError) {
      const reasons = err.errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join("; ");
      throw new Error(`Failed to publish to any relay: ${reasons}`);
    }
    throw new Error(
      `Failed to save to Nostr: ${err instanceof Error ? err.message : "Unknown error"}`
    );
  }
}

/**
 * Load and decrypt history from Nostr relays
 * Returns HistoryPayload with embedded timestamp and sessionId
 */
export async function loadHistoryFromNostr(
  userPrivateKey: Uint8Array,
  userPublicKey: string,
  signal?: AbortSignal
): Promise<HistoryPayload | null> {
  throwIfAborted(signal);
  const events = await pool.querySync(
    RELAYS,
    {
      kinds: [KIND_HISTORY],
      authors: [userPublicKey],
      "#d": [D_TAG],
      limit: 1,
    }
  );
  throwIfAborted(signal);

  if (events.length === 0) {
    return null;
  }

  // Get most recent event
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];

  const payload = parseAndValidateEventContent(latest.content);

  // Decrypt returns HistoryPayload with timestamp and sessionId
  return decryptHistory(
    payload.ciphertext,
    payload.ephemeralPubKey,
    userPrivateKey
  );
}

/**
 * Subscribe to history updates with full payload decryption
 * Returns HistoryPayload with embedded timestamp and sessionId
 */
export function subscribeToHistoryDetailed(
  userPublicKey: string,
  userPrivateKey: Uint8Array,
  onEvent: (payload: HistoryPayload) => void
): () => void {
  try {
    const sub = pool.subscribeMany(
      RELAYS,
      {
        kinds: [KIND_HISTORY],
        authors: [userPublicKey],
        "#d": [D_TAG],
      },
      {
        onevent: (event) => {
          try {
            const payload = parseAndValidateEventContent(event.content);

            // decryptHistory returns HistoryPayload with timestamp and sessionId
            const historyPayload = decryptHistory(
              payload.ciphertext,
              payload.ephemeralPubKey,
              userPrivateKey
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

export interface MergeResult {
  merged: HistoryEntry[];
  addedFromCloud: number;
}

/**
 * Merge remote history into local history.
 * Remote is the source of truth for ordering, URLs, titles, and gain.
 * Local position is preserved only when local lastPlayedAt is newer for the same URL.
 *
 * @example Position preserved when local is newer
 * ```
 * local:  [{url:"A", position:50, lastPlayedAt:"2024-01-02"}]
 * remote: [{url:"A", position:10, lastPlayedAt:"2024-01-01"}, {url:"B", position:20, lastPlayedAt:"2024-01-01"}]
 * merged: [{url:"A", position:50, lastPlayedAt:"2024-01-01"}, {url:"B", position:20, lastPlayedAt:"2024-01-01"}]
 * // URL "A": remote entry with local position (local timestamp is newer)
 * // URL "B": remote entry as-is (not in local)
 * ```
 *
 * @example Remote wins when remote is newer
 * ```
 * local:  [{url:"A", position:50, lastPlayedAt:"2024-01-01"}]
 * remote: [{url:"A", position:10, lastPlayedAt:"2024-01-02"}]
 * merged: [{url:"A", position:10, lastPlayedAt:"2024-01-02"}]
 * ```
 */
export function mergeHistory(
  local: HistoryEntry[],
  remote: HistoryEntry[]
): MergeResult {
  const localByUrl = new Map(local.map((e) => [e.url, e]));

  let addedFromCloud = 0;

  // Remote is the base - use remote order and entries
  const merged = remote.map((remoteEntry) => {
    const localEntry = localByUrl.get(remoteEntry.url);
    if (!localEntry) {
      addedFromCloud++;
      return remoteEntry;
    }

    // Same URL exists in both - check if local position should be preserved
    const localTimeParsed = new Date(localEntry.lastPlayedAt).getTime();
    const remoteTimeParsed = new Date(remoteEntry.lastPlayedAt).getTime();

    // Treat invalid timestamps as -Infinity for deterministic comparison
    const localTime = Number.isFinite(localTimeParsed) ? localTimeParsed : -Infinity;
    const remoteTime = Number.isFinite(remoteTimeParsed) ? remoteTimeParsed : -Infinity;

    // Both invalid: fall back to remote
    if (localTime === -Infinity && remoteTime === -Infinity) {
      return remoteEntry;
    }

    if (localTime > remoteTime) {
      // Local is newer - preserve position only, use remote for everything else
      return { ...remoteEntry, position: localEntry.position };
    }

    // Remote wins entirely
    return remoteEntry;
  });

  return {
    merged,
    addedFromCloud,
  };
}
