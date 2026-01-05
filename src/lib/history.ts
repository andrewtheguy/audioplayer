import {
  getHistoryStorageKey,
  getHistoryTimestampStorageKey,
} from "./identity";

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

export function getHistory(fingerprint: string | undefined): HistoryEntry[] {
  if (!fingerprint) return [];
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

export function saveHistory(history: HistoryEntry[], fingerprint: string | undefined): void {
  if (!fingerprint) return;
  try {
    const historyKey = getHistoryStorageKey(fingerprint);
    const timestampKey = getHistoryTimestampStorageKey(fingerprint);
    // Trim to MAX_HISTORY_ENTRIES before saving (keeps most recent)
    const trimmed = trimHistory(history);
    localStorage.setItem(historyKey, JSON.stringify(trimmed));
    localStorage.setItem(timestampKey, Date.now().toString());
  } catch (err) {
    // Storage full or unavailable
    console.warn("Failed to save history to localStorage:", err);
  }
}
