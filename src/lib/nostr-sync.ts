import { finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { HistoryEntry } from "./history";
import { encryptHistory, decryptHistory } from "./pin-crypto";

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

const KIND_HISTORY = 30078; // NIP-78: Application-specific replaceable data
const D_TAG = "audioplayer-history";

const pool = new SimplePool();

/**
 * Close all relay connections to avoid resource leaks.
 * Call this during application shutdown or cleanup.
 */
export function closePool(): void {
  pool.close(RELAYS);
}

// Register cleanup on page unload (browser environment)
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", closePool);
}

/**
 * Validate the encrypted payload structure from a Nostr event
 */
function isValidPayload(
  value: unknown
): value is { v: number; ephemeralPubKey: string; ciphertext: string } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.v === "number" &&
    typeof obj.ephemeralPubKey === "string" &&
    typeof obj.ciphertext === "string"
  );
}

/**
 * Save encrypted history to Nostr relays.
 * Throws descriptive error if all relays fail.
 */
export async function saveHistoryToNostr(
  history: HistoryEntry[],
  userPrivateKey: Uint8Array,
  userPublicKey: string
): Promise<void> {
  const { ciphertext, ephemeralPubKey } = encryptHistory(history, userPublicKey);

  const payload = JSON.stringify({
    v: 1,
    ephemeralPubKey,
    ciphertext,
  });

  const event = finalizeEvent(
    {
      kind: KIND_HISTORY,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", D_TAG],
        ["client", "audioplayer"],
      ],
      content: payload,
    },
    userPrivateKey
  );

  try {
    await Promise.any(pool.publish(RELAYS, event));
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
 */
export async function loadHistoryFromNostr(
  userPrivateKey: Uint8Array,
  userPublicKey: string
): Promise<HistoryEntry[] | null> {
  const events = await pool.querySync(
    RELAYS,
    {
      kinds: [KIND_HISTORY],
      authors: [userPublicKey],
      "#d": [D_TAG],
      limit: 1,
    }
  );

  if (events.length === 0) {
    return null;
  }

  // Get most recent event
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];

  // Parse and validate payload structure
  let payload: unknown;
  try {
    payload = JSON.parse(latest.content);
  } catch {
    throw new Error("Event content is not valid JSON. Data may be corrupted.");
  }

  if (!isValidPayload(payload)) {
    throw new Error(
      "Invalid payload structure: missing or invalid ephemeralPubKey/ciphertext fields"
    );
  }

  // Decrypt with validated payload
  return decryptHistory(payload.ciphertext, payload.ephemeralPubKey, userPrivateKey);
}

export interface MergeResult {
  merged: HistoryEntry[];
  addedFromCloud: number;
  duplicatesSkipped: number;
}

/**
 * Merge cloud history into local history
 * Keep all local entries, only add URLs from cloud that don't exist locally
 */
export function mergeHistory(
  local: HistoryEntry[],
  cloud: HistoryEntry[]
): MergeResult {
  const localUrls = new Set(local.map((e) => e.url));
  const newFromCloud = cloud.filter((e) => !localUrls.has(e.url));
  const duplicatesSkipped = cloud.length - newFromCloud.length;

  return {
    merged: [...local, ...newFromCloud],
    addedFromCloud: newFromCloud.length,
    duplicatesSkipped,
  };
}
