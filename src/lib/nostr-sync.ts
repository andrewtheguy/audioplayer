import { finalizeEvent } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";
import type { HistoryEntry } from "./history";
import { encryptHistory, decryptHistory } from "./pin-crypto";

const RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

const KIND_HISTORY = 30078; // NIP-78: Application-specific replaceable data
const D_TAG = "audioplayer-history";

const pool = new SimplePool();

/**
 * Save encrypted history to Nostr relays
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

  await Promise.any(pool.publish(RELAYS, event));
}

/**
 * Load and decrypt history from Nostr relays
 */
export async function loadHistoryFromNostr(
  userPrivateKey: Uint8Array,
  userPublicKey: string
): Promise<HistoryEntry[] | null> {
  const events = await pool.querySync(RELAYS, {
    kinds: [KIND_HISTORY],
    authors: [userPublicKey],
    "#d": [D_TAG],
    limit: 1,
  });

  if (events.length === 0) {
    return null;
  }

  // Get most recent event
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0];

  try {
    const payload = JSON.parse(latest.content);
    const { ephemeralPubKey, ciphertext } = payload;

    return decryptHistory(ciphertext, ephemeralPubKey, userPrivateKey);
  } catch (err) {
    console.error("Failed to decrypt history:", err);
    throw new Error("Failed to decrypt history. Wrong PIN?");
  }
}

/**
 * Merge cloud history into local history
 * Keep all local entries, only add URLs from cloud that don't exist locally
 */
export function mergeHistory(
  local: HistoryEntry[],
  cloud: HistoryEntry[]
): HistoryEntry[] {
  const localUrls = new Set(local.map((e) => e.url));
  const newFromCloud = cloud.filter((e) => !localUrls.has(e.url));

  return [...local, ...newFromCloud];
}
