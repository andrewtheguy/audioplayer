import { getHistoryStorageKey } from "./identity";

export const MAX_HISTORY_ENTRIES = 100;

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

/**
 * Validate that a value is a valid HistoryPayload
 */
function isValidHistoryPayload(value: unknown): value is HistoryPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    Array.isArray(payload.history) &&
    typeof payload.timestamp === "number" &&
    (payload.sessionId === undefined || typeof payload.sessionId === "string")
  );
}

/**
 * Get history payload from localStorage (atomic: history + timestamp together)
 * Returns null if no history exists or on parse error
 */
function getHistoryPayload(fingerprint: string | undefined): HistoryPayload | null {
  if (!fingerprint) return null;
  try {
    const key = getHistoryStorageKey(fingerprint);
    const data = localStorage.getItem(key);
    if (!data) return null;

    const parsed: unknown = JSON.parse(data);

    // Handle new format (HistoryPayload object)
    if (isValidHistoryPayload(parsed)) {
      const validated = validateHistoryArray(parsed.history);
      return {
        history: trimHistory(validated),
        timestamp: parsed.timestamp,
        sessionId: parsed.sessionId,
      };
    }

    // Handle legacy format (plain array) - migrate on read
    if (Array.isArray(parsed)) {
      const validated = validateHistoryArray(parsed);
      return {
        history: trimHistory(validated),
        timestamp: Date.now(),
      };
    }

    console.warn("Unknown history format in localStorage");
    return null;
  } catch (err) {
    console.warn("Failed to parse history from localStorage:", err);
    return null;
  }
}

/**
 * Get history entries from localStorage
 */
export function getHistory(fingerprint: string | undefined): HistoryEntry[] {
  return getHistoryPayload(fingerprint)?.history ?? [];
}

/**
 * Get the timestamp when history was last saved
 * Returns null if no history exists
 */
export function getHistoryTimestamp(fingerprint: string | undefined): number | null {
  return getHistoryPayload(fingerprint)?.timestamp ?? null;
}

/**
 * Save history payload to localStorage (atomic: history + timestamp together)
 */
export function saveHistory(
  history: HistoryEntry[],
  fingerprint: string | undefined,
  sessionId?: string
): void {
  if (!fingerprint) return;
  try {
    const key = getHistoryStorageKey(fingerprint);
    const trimmed = trimHistory(history);
    const payload: HistoryPayload = {
      history: trimmed,
      timestamp: Date.now(),
      sessionId,
    };
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (err) {
    console.warn("Failed to save history to localStorage:", err);
  }
}
