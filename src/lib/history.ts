export const STORAGE_KEY = "com.audioplayer.history.v1";
export const HISTORY_TIMESTAMP_KEY = "com.audioplayer.history.timestamp";
export const LAST_USED_SECRET_KEY = "com.audioplayer.session.last_used_secret";
export const SESSION_STATE_KEY = "com.audioplayer.session.state";
export const MAX_HISTORY_ENTRIES = 100;

/**
 * Session state stored in sessionStorage to detect true session takeovers on resume.
 * Using sessionStorage ensures this data is cleared when the tab/browser is closed,
 * which is the correct behavior since a new tab should start fresh.
 */
export interface SessionState {
  sessionId: string;
  lastPublishedTimestamp: number;
}

/**
 * Simple sync hash for sessionStorage keys.
 * Uses first 16 chars of secret - sufficient for key uniqueness.
 * For sensitive fingerprints, use getStorageFingerprint instead.
 */
export function getSecretKeyPrefix(secret: string): string {
  return secret.slice(0, 16);
}

function getSessionStateKey(secretKeyPrefix: string): string {
  return `${SESSION_STATE_KEY}.${secretKeyPrefix}`;
}

export function getSessionState(fingerprint: string): SessionState | null {
  try {
    const key = getSessionStateKey(fingerprint);
    const data = sessionStorage.getItem(key);
    if (!data) return null;
    const parsed = JSON.parse(data);
    if (typeof parsed.sessionId === "string" && typeof parsed.lastPublishedTimestamp === "number") {
      return parsed as SessionState;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSessionState(fingerprint: string, state: SessionState): void {
  try {
    const key = getSessionStateKey(fingerprint);
    sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // sessionStorage unavailable
  }
}

export function clearSessionState(fingerprint: string): void {
  try {
    const key = getSessionStateKey(fingerprint);
    sessionStorage.removeItem(key);
  } catch {
    // sessionStorage unavailable
  }
}

/**
 * Generate a storage-key-safe fingerprint from a secret.
 * Returns 16 hex characters (first 64 bits of SHA-256 hash).
 */
export async function getStorageFingerprint(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getHistoryStorageKey(fingerprint?: string): string {
  return fingerprint ? `${STORAGE_KEY}.${fingerprint}` : STORAGE_KEY;
}

export function getTimestampStorageKey(fingerprint?: string): string {
  return fingerprint ? `${HISTORY_TIMESTAMP_KEY}.${fingerprint}` : HISTORY_TIMESTAMP_KEY;
}

export interface HistoryEntry {
  url: string;
  title?: string;
  lastPlayedAt: string;
  position: number;
  gain?: number;
}

export interface HistoryPayload {
  history: HistoryEntry[];
  timestamp: number; // Date.now() milliseconds
  sessionId?: string;
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
 * Validate and filter an array to only valid HistoryEntry items
 */
function validateHistoryArray(data: unknown): HistoryEntry[] {
  if (!Array.isArray(data)) {
    console.warn("History data is not an array, returning empty history");
    return [];
  }

  const valid: HistoryEntry[] = [];
  for (const item of data) {
    if (isValidHistoryEntry(item)) {
      valid.push(item);
    } else {
      console.warn("Skipping invalid history entry:", item);
    }
  }

  return valid;
}

/**
 * Trim history to MAX_HISTORY_ENTRIES, keeping most recent entries.
 * Assumes history is sorted with most recent first.
 */
function trimHistory(history: HistoryEntry[]): HistoryEntry[] {
  if (history.length <= MAX_HISTORY_ENTRIES) {
    return history;
  }
  return history.slice(0, MAX_HISTORY_ENTRIES);
}

export function getHistory(fingerprint?: string): HistoryEntry[] {
  try {
    const key = getHistoryStorageKey(fingerprint);
    const data = localStorage.getItem(key);
    if (!data) return [];

    const parsed = JSON.parse(data);
    const validated = validateHistoryArray(parsed);

    // Ensure we never return more than MAX_HISTORY_ENTRIES
    return trimHistory(validated);
  } catch (err) {
    console.warn("Failed to parse history from localStorage:", err);
    return [];
  }
}

export function saveHistory(history: HistoryEntry[], fingerprint?: string): void {
  try {
    const historyKey = getHistoryStorageKey(fingerprint);
    const timestampKey = getTimestampStorageKey(fingerprint);
    // Trim to MAX_HISTORY_ENTRIES before saving (keeps most recent)
    const trimmed = trimHistory(history);
    localStorage.setItem(historyKey, JSON.stringify(trimmed));
    localStorage.setItem(timestampKey, Date.now().toString());
  } catch (err) {
    // Storage full or unavailable
    console.warn("Failed to save history to localStorage:", err);
  }
}

export function getLastUsedSecret(): string | null {
  try {
    return localStorage.getItem(LAST_USED_SECRET_KEY) || null;
  } catch (err) {
    console.warn("Failed to get last used secret:", err);
    return null;
  }
}

export function saveLastUsedSecret(secret: string): void {
  try {
    localStorage.setItem(LAST_USED_SECRET_KEY, secret);
  } catch (err) {
    console.warn("Failed to save last used secret:", err);
  }
}
