import { finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { HistoryEntry } from "./history";
import { encryptHistory, decryptHistory } from "./nostr-crypto";

export const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  //"wss://relay.nostr.band",
  "wss://nos.lol",
];

const KIND_HISTORY = 30078; // NIP-78: Application-specific replaceable data
const D_TAG = "audioplayer-history";

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
  userPublicKey: string,
  sessionId?: string,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  const { ciphertext, ephemeralPubKey } = encryptHistory(history, userPublicKey);

  const payload = JSON.stringify({
    v: 1,
    ephemeralPubKey,
    ciphertext,
  });

  const tags = [
    ["d", D_TAG],
    ["client", "audioplayer"],
  ];
  if (sessionId) {
    tags.push(["session", sessionId]);
  }

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
 */
export async function loadHistoryFromNostr(
  userPrivateKey: Uint8Array,
  userPublicKey: string,
  signal?: AbortSignal
): Promise<{ history: HistoryEntry[]; sessionId: string | null } | null> {
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

  // Extract session ID from tags
  const sessionTag = latest.tags.find((t) => t[0] === "session");
  const sessionId = sessionTag ? sessionTag[1] : null;

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
  const history = decryptHistory(
    payload.ciphertext,
    payload.ephemeralPubKey,
    userPrivateKey
  );
  return { history, sessionId };
}

/**
 * Subscribe to history updates
 * Returns a cleanup function to unsubscribe
 */
export function subscribeToHistory(
  userPublicKey: string,
  onEvent: (sessionId: string | null) => void
): () => void {
  const canSetOnError = (
    value: unknown
  ): value is { onerror?: (err: unknown) => void } => {
    if (!value || typeof value !== "object") return false;
    const maybe = value as { onerror?: unknown };
    return typeof maybe.onerror === "undefined" || typeof maybe.onerror === "function";
  };

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
            const sessionTag = event.tags.find((t) => t[0] === "session");
            onEvent(sessionTag ? sessionTag[1] : null);
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
  duplicatesSkipped: number;
}

export interface MergeOptions {
  preferRemote?: boolean;
  preferRemoteOrder?: boolean;
}

/**
 * Merge cloud history into local history
 * Keep local order, add URLs from cloud that don't exist locally.
 * If preferRemote is true, remote entries replace local entries for the same URL.
 */
export function mergeHistory(
  local: HistoryEntry[],
  cloud: HistoryEntry[],
  options?: MergeOptions
): MergeResult {
  const localByUrl = new Map(local.map((e) => [e.url, e]));
  const cloudByUrl = new Map(cloud.map((e) => [e.url, e]));
  const preferRemote = options?.preferRemote === true;
  const preferRemoteOrder = options?.preferRemoteOrder === true;

  const newFromCloud = cloud.filter((e) => !localByUrl.has(e.url));
  const duplicatesSkipped = cloud.length - newFromCloud.length;
  const resolveTitle = (
    primary: HistoryEntry,
    secondary?: HistoryEntry
  ): HistoryEntry => {
    if (primary.title || !secondary?.title) {
      return primary;
    }
    return { ...primary, title: secondary.title };
  };

  if (preferRemoteOrder) {
    const mergedFromRemote = cloud.map((entry) => {
      if (preferRemote) {
        return resolveTitle(entry, localByUrl.get(entry.url));
      }
      const localEntry = localByUrl.get(entry.url);
      if (localEntry) {
        return resolveTitle(localEntry, entry);
      }
      return entry;
    });

    const newFromLocal = local.filter((e) => !cloudByUrl.has(e.url));

    return {
      merged: [...mergedFromRemote, ...newFromLocal],
      addedFromCloud: newFromCloud.length,
      duplicatesSkipped,
    };
  }

  const merged = local.map((entry) => {
    if (!preferRemote) {
      return resolveTitle(entry, cloudByUrl.get(entry.url));
    }
    const remote = cloudByUrl.get(entry.url);
    return remote ? resolveTitle(remote, entry) : entry;
  });

  return {
    merged: [...merged, ...newFromCloud],
    addedFromCloud: newFromCloud.length,
    duplicatesSkipped,
  };
}
