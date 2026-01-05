/**
 * Identity management: npub/nsec handling
 * All localStorage keys are scoped by npub fingerprint for isolation
 * Note: Player ID is not cached locally - it's always fetched from relay
 */

const STORAGE_PREFIX = "com.audioplayer";

export interface IdentityState {
  npub: string;
  pubkeyHex: string;
  playerId: string | null;
  hasSecondarySecret: boolean;
}

/**
 * Get fingerprint for localStorage scoping (first 32 hex chars / 128 bits of SHA-256 of pubkey)
 */
export async function getNpubFingerprint(pubkeyHex: string): Promise<string> {
  // Validate input
  if (!pubkeyHex || typeof pubkeyHex !== "string") {
    throw new Error("Invalid pubkeyHex: must be a non-empty string");
  }
  if (!/^[0-9a-fA-F]+$/.test(pubkeyHex)) {
    throw new Error("Invalid pubkeyHex: must contain only hexadecimal characters");
  }
  if (pubkeyHex.length !== 64) {
    throw new Error("Invalid pubkeyHex: expected 64 hex characters (32 bytes)");
  }

  let hashBuffer: ArrayBuffer;
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(pubkeyHex);
    hashBuffer = await crypto.subtle.digest("SHA-256", data);
  } catch (err) {
    throw new Error(
      `Failed to compute fingerprint: ${err instanceof Error ? err.message : "Unknown crypto error"}`
    );
  }

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 32);
}

// =============================================================================
// Secondary Secret Management
// =============================================================================

function getSecondarySecretKey(fingerprint: string): string {
  return `${STORAGE_PREFIX}.secondary-secret.${fingerprint}`;
}

/**
 * Get secondary secret from localStorage for a given npub fingerprint
 */
export function getSecondarySecret(fingerprint: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(getSecondarySecretKey(fingerprint));
}

/**
 * Store secondary secret in localStorage
 */
export function setSecondarySecret(fingerprint: string, secret: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(getSecondarySecretKey(fingerprint), secret);
}

/**
 * Clear secondary secret from localStorage
 */
export function clearSecondarySecret(fingerprint: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(getSecondarySecretKey(fingerprint));
}

// =============================================================================
// nsec Storage (optional, for user convenience)
// =============================================================================

function getNsecKey(fingerprint: string): string {
  return `${STORAGE_PREFIX}.nsec.${fingerprint}`;
}

/**
 * Get stored nsec from localStorage (returns null if not stored)
 */
export function getStoredNsec(fingerprint: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(getNsecKey(fingerprint));
}

/**
 * Store nsec in localStorage
 */
export function storeNsec(fingerprint: string, nsec: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(getNsecKey(fingerprint), nsec);
}

/**
 * Clear nsec from localStorage
 */
export function clearNsec(fingerprint: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(getNsecKey(fingerprint));
}

// =============================================================================
// History Storage (per npub fingerprint)
// =============================================================================

function getHistoryKey(fingerprint: string): string {
  return `${STORAGE_PREFIX}.history.v1.${fingerprint}`;
}

function getHistoryTimestampKey(fingerprint: string): string {
  return `${STORAGE_PREFIX}.history.timestamp.${fingerprint}`;
}

/**
 * Get history storage key for a given fingerprint
 */
export function getHistoryStorageKey(fingerprint: string): string {
  return getHistoryKey(fingerprint);
}

/**
 * Get history timestamp key for a given fingerprint
 */
export function getHistoryTimestampStorageKey(fingerprint: string): string {
  return getHistoryTimestampKey(fingerprint);
}

// =============================================================================
// Clear All Identity Data
// =============================================================================

/**
 * Clear all identity-related data for a given fingerprint
 */
export function clearAllIdentityData(fingerprint: string): void {
  if (typeof window === "undefined") return;
  clearSecondarySecret(fingerprint);
  clearNsec(fingerprint);
  localStorage.removeItem(getHistoryKey(fingerprint));
  localStorage.removeItem(getHistoryTimestampKey(fingerprint));
}
