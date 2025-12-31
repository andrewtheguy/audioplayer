export const STORAGE_KEY = "com.audioplayer.history.v1";
export const HISTORY_TIMESTAMP_KEY = "com.audioplayer.history.timestamp";
export const MAX_HISTORY_ENTRIES = 100;

export interface HistoryEntry {
  url: string;
  lastPlayedAt: string;
  position: number;
  gain?: number;
}

export function getHistory(): HistoryEntry[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveHistory(history: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    localStorage.setItem(HISTORY_TIMESTAMP_KEY, Date.now().toString());
  } catch {
    // Storage full or unavailable
  }
}
