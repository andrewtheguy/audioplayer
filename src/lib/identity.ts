/**
 * Identity management: npub/nsec handling
 * Uses global localStorage keys (single user at a time)
 * Note: Player ID is not cached locally - it's always fetched from relay
 */

const STORAGE_PREFIX = "com.audioplayer";

export interface IdentityState {
  npub: string;
  pubkeyHex: string;
  playerId: string | null;
  hasSecondarySecret: boolean;
}

// =============================================================================
// Global Storage Keys
// =============================================================================

export const STORAGE_KEYS = {
  NPUB: `${STORAGE_PREFIX}.npub`,
  SECONDARY_SECRET: `${STORAGE_PREFIX}.secondary-secret`,
  HISTORY: `${STORAGE_PREFIX}.history.v1`,
} as const;

// =============================================================================
// Secondary Secret Management (Global - not scoped by user)
// =============================================================================

/**
 * Get secondary secret from localStorage
 */
export function getSecondarySecret(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEYS.SECONDARY_SECRET);
}

/**
 * Store secondary secret in localStorage
 */
export function setSecondarySecret(secret: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.SECONDARY_SECRET, secret);
}

/**
 * Clear secondary secret from localStorage
 */
export function clearSecondarySecret(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEYS.SECONDARY_SECRET);
}

// =============================================================================
// History Storage (Global - not scoped by user)
// =============================================================================

/**
 * Get history storage key
 */
export function getHistoryStorageKey(): string {
  return STORAGE_KEYS.HISTORY;
}

// =============================================================================
// Clear All Identity Data
// =============================================================================

/**
 * Clear all identity-related data
 */
export function clearAllIdentityData(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEYS.NPUB);
  localStorage.removeItem(STORAGE_KEYS.SECONDARY_SECRET);
  localStorage.removeItem(STORAGE_KEYS.HISTORY);
}
