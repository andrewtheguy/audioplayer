import { useCallback, useEffect, useRef, useState } from "react";
import { getPublicKey } from "nostr-tools/pure";
import {
  parseNpubFromHash,
  decodeNsec,
  generatePlayerId,
  isValidPlayerId,
  generateSecondarySecret,
  isValidSecondarySecret,
  generateNostrKeypair,
  deriveEncryptionKey,
} from "@/lib/nostr-crypto";
import {
  getStorageScope,
  getSecondarySecret,
  setSecondarySecret,
  clearSecondarySecret,
  storeNsec,
} from "@/lib/identity";
import {
  loadPlayerIdFromNostr,
  publishPlayerIdToNostr,
  PlayerIdDecryptionError,
} from "@/lib/nostr-sync";

export type SessionStatus =
  | "no_npub" // No npub in URL
  | "needs_secret" // Has npub, needs secondary secret entry
  | "loading" // Fetching player id from relay
  | "needs_setup" // No player id exists, needs nsec to create initial one
  | "idle" // Ready, has player id, not started
  | "active" // Active session on this device
  | "stale" // Another device took over
  | "invalid"; // Invalid npub format

interface UseNostrSessionOptions {
  sessionId?: string;
  onSessionStatusChange?: (status: SessionStatus) => void;
  takeoverGraceMs?: number;
}

interface UseNostrSessionResult {
  // Identity
  npub: string | null;
  pubkeyHex: string | null;

  // Player ID and encryption keys
  playerId: string | null;
  encryptionKeys: { privateKey: Uint8Array; publicKey: string } | null;

  // Secondary secret
  secondarySecret: string | null;

  // Session state
  sessionStatus: SessionStatus;
  sessionNotice: string | null;
  localSessionId: string;
  ignoreRemoteUntil: number;

  // State setters
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;

  // Identity actions
  generateNewIdentity: () => Promise<{ npub: string; nsec: string }>;
  submitSecondarySecret: (secret: string) => Promise<boolean>;
  setupWithNsec: (nsec: string, newSecondarySecret?: string) => Promise<boolean>;
  rotatePlayerId: (nsec: string) => Promise<boolean>;
}

const DEFAULT_TAKEOVER_GRACE_MS = 15000;

function getNpubFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  const npub = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!npub || !npub.startsWith("npub1")) {
    return null;
  }
  return npub;
}

export function useNostrSession({
  sessionId,
  onSessionStatusChange,
  takeoverGraceMs = DEFAULT_TAKEOVER_GRACE_MS,
}: UseNostrSessionOptions): UseNostrSessionResult {
  // Identity state
  const [npub, setNpub] = useState<string | null>(null);
  const [pubkeyHex, setPubkeyHex] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  // Player ID and keys
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [encryptionKeys, setEncryptionKeys] = useState<{
    privateKey: Uint8Array;
    publicKey: string;
  } | null>(null);

  // Secondary secret
  const [secondarySecret, setSecondarySecretState] = useState<string | null>(null);

  // Session state
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("no_npub");
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [localSessionId] = useState(() => sessionId ?? crypto.randomUUID());
  const [ignoreRemoteUntil, setIgnoreRemoteUntil] = useState<number>(0);

  const prevStatusRef = useRef<SessionStatus>(sessionStatus);
  const staleNoticeTimerRef = useRef<number | null>(null);
  const onSessionStatusChangeRef = useRef(onSessionStatusChange);
  const initializingRef = useRef(false);

  useEffect(() => {
    onSessionStatusChangeRef.current = onSessionStatusChange;
  }, [onSessionStatusChange]);

  useEffect(() => {
    onSessionStatusChangeRef.current?.(sessionStatus);
  }, [sessionStatus]);

  // Show stale notice when session becomes stale
  useEffect(() => {
    if (prevStatusRef.current !== "stale" && sessionStatus === "stale") {
      if (staleNoticeTimerRef.current) {
        clearTimeout(staleNoticeTimerRef.current);
      }
      staleNoticeTimerRef.current = window.setTimeout(() => {
        setSessionNotice("Another device is now active.");
        staleNoticeTimerRef.current = null;
      }, 0);
    }
    prevStatusRef.current = sessionStatus;
    return () => {
      if (staleNoticeTimerRef.current) {
        clearTimeout(staleNoticeTimerRef.current);
        staleNoticeTimerRef.current = null;
      }
    };
  }, [sessionStatus]);

  // Initialize session on mount and hash changes
  const initializeSession = useCallback(async () => {
    if (initializingRef.current) return;
    initializingRef.current = true;

    try {
      // 1. Parse npub from URL hash
      const currentNpub = getNpubFromHash();
      if (!currentNpub) {
        setNpub(null);
        setPubkeyHex(null);
        setFingerprint(null);
        setPlayerId(null);
        setEncryptionKeys(null);
        setSecondarySecretState(null);
        setSessionStatus("no_npub");
        return;
      }

      // 2. Validate and decode npub
      const hex = parseNpubFromHash(currentNpub);
      if (!hex) {
        setNpub(currentNpub);
        setPubkeyHex(null);
        setSessionStatus("invalid");
        setSessionNotice("Invalid npub format in URL.");
        return;
      }

      setNpub(currentNpub);
      setPubkeyHex(hex);

      // 3. Get fingerprint for localStorage scoping
      const fp = await getStorageScope(hex);
      setFingerprint(fp);

      // 4. Check for cached secondary secret
      const cachedSecret = getSecondarySecret(fp);
      if (!cachedSecret) {
        setSessionStatus("needs_secret");
        return;
      }

      setSecondarySecretState(cachedSecret);

      // 5. Try to load player id from relay
      setSessionStatus("loading");
      try {
        const remotePlayerId = await loadPlayerIdFromNostr(hex, cachedSecret);
        if (remotePlayerId && isValidPlayerId(remotePlayerId)) {
          setPlayerId(remotePlayerId);
          const keys = await deriveEncryptionKey(remotePlayerId);
          setEncryptionKeys(keys);
          setSessionStatus("idle");
          return;
        }
        // No player id event exists - needs setup with nsec
        setSessionStatus("needs_setup");
        return;
      } catch (err) {
        if (err instanceof PlayerIdDecryptionError) {
          // Decryption failed - wrong secondary secret
          console.warn("Failed to decrypt player id:", err.message);
          setSessionStatus("needs_secret");
          setSessionNotice("Wrong secondary secret. Please re-enter.");
          // Clear the invalid secret from both React state and localStorage
          setSecondarySecretState(null);
          clearSecondarySecret(fp);
          return;
        }
        // Network or other error - preserve the secret and show error
        console.warn("Failed to load player id from relay:", err);
        setSessionStatus("needs_secret");
        setSessionNotice(
          `Network error: ${err instanceof Error ? err.message : "Failed to connect to relay"}. Please try again.`
        );
        // Don't clear the secret - it might be valid, just network issues
        return;
      }
    } finally {
      initializingRef.current = false;
    }
  }, []);

  // Run initialization on mount
  useEffect(() => {
    initializeSession();
  }, [initializeSession]);

  // Listen for hash changes
  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleHashChange = () => {
      // Reset state and re-initialize
      setPlayerId(null);
      setEncryptionKeys(null);
      initializeSession();
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, [initializeSession]);

  // Generate new identity (npub/nsec pair)
  const generateNewIdentity = useCallback(async (): Promise<{
    npub: string;
    nsec: string;
  }> => {
    const keypair = generateNostrKeypair();

    // Set the npub in URL hash
    if (typeof window !== "undefined") {
      window.location.hash = keypair.npub;
    }

    return {
      npub: keypair.npub,
      nsec: keypair.nsec,
    };
  }, []);

  // Submit secondary secret
  const submitSecondarySecret = useCallback(
    async (secret: string): Promise<boolean> => {
      if (!isValidSecondarySecret(secret)) {
        setSessionNotice("Invalid secondary secret format.");
        return false;
      }

      if (!pubkeyHex || !fingerprint) {
        setSessionNotice("No identity loaded.");
        return false;
      }

      // Set React state for UI feedback (defer localStorage until validated)
      setSecondarySecretState(secret);

      // Try to load player id from relay with new secret
      setSessionStatus("loading");
      try {
        const remotePlayerId = await loadPlayerIdFromNostr(pubkeyHex, secret);
        if (remotePlayerId && isValidPlayerId(remotePlayerId)) {
          // Success - now persist to localStorage
          setSecondarySecret(fingerprint, secret);
          setPlayerId(remotePlayerId);
          const keys = await deriveEncryptionKey(remotePlayerId);
          setEncryptionKeys(keys);
          setSessionStatus("idle");
          setSessionNotice(null);
          return true;
        }
        // No player id exists - secret is valid, persist and proceed to setup
        setSecondarySecret(fingerprint, secret);
        setSessionStatus("needs_setup");
        setSessionNotice(null);
        return true;
      } catch (err) {
        if (err instanceof PlayerIdDecryptionError) {
          // Decryption failed - wrong secret, clear React state (not persisted yet)
          setSecondarySecretState(null);
          setSessionNotice("Wrong secondary secret. Please re-enter.");
          setSessionStatus("needs_secret");
          return false;
        }
        // Network or other error - persist secret for retry and show error
        setSecondarySecret(fingerprint, secret);
        setSessionNotice(
          `Network error: ${err instanceof Error ? err.message : "Failed to connect to relay"}. Please try again.`
        );
        setSessionStatus("needs_secret");
        return false;
      }
    },
    [pubkeyHex, fingerprint]
  );

  // Setup with nsec (create initial player id)
  const setupWithNsec = useCallback(
    async (nsec: string, newSecondarySecret?: string): Promise<boolean> => {
      // Decode nsec
      const privateKeyBytes = decodeNsec(nsec);
      if (!privateKeyBytes) {
        setSessionNotice("Invalid nsec format.");
        return false;
      }

      // Verify nsec matches npub
      const derivedPubkey = getPublicKey(privateKeyBytes);
      if (derivedPubkey !== pubkeyHex) {
        setSessionNotice("nsec does not match this identity.");
        return false;
      }

      if (!fingerprint) {
        setSessionNotice("No identity loaded.");
        return false;
      }

      // Use provided secret or existing or generate new
      let secret = newSecondarySecret;
      if (!secret) {
        secret = secondarySecret || generateSecondarySecret();
      }

      if (!isValidSecondarySecret(secret)) {
        setSessionNotice("Invalid secondary secret format.");
        return false;
      }

      // Store the secret
      setSecondarySecret(fingerprint, secret);
      setSecondarySecretState(secret);

      // Optionally store nsec for convenience
      storeNsec(fingerprint, nsec);

      // Generate new player id
      const newPlayerId = generatePlayerId();

      // Publish to relay
      setSessionStatus("loading");
      try {
        await publishPlayerIdToNostr(
          newPlayerId,
          secret,
          privateKeyBytes,
          pubkeyHex!
        );
      } catch (err) {
        setSessionNotice(
          `Failed to publish player ID: ${err instanceof Error ? err.message : "Unknown error"}`
        );
        setSessionStatus("needs_setup");
        return false;
      }

      // Set player id and derive encryption keys
      setPlayerId(newPlayerId);

      const keys = await deriveEncryptionKey(newPlayerId);
      setEncryptionKeys(keys);

      setSessionStatus("idle");
      setSessionNotice(null);

      return true;
    },
    [pubkeyHex, fingerprint, secondarySecret]
  );

  // Rotate player id
  const rotatePlayerId = useCallback(
    async (nsec: string): Promise<boolean> => {
      // Decode nsec
      const privateKeyBytes = decodeNsec(nsec);
      if (!privateKeyBytes) {
        setSessionNotice("Invalid nsec format.");
        return false;
      }

      // Verify nsec matches npub
      const derivedPubkey = getPublicKey(privateKeyBytes);
      if (derivedPubkey !== pubkeyHex) {
        setSessionNotice("nsec does not match this identity.");
        return false;
      }

      if (!fingerprint || !secondarySecret) {
        setSessionNotice("Missing secondary secret.");
        return false;
      }

      // Generate new player id
      const newPlayerId = generatePlayerId();

      // Publish to relay (replaces old event)
      setSessionStatus("loading");
      try {
        await publishPlayerIdToNostr(
          newPlayerId,
          secondarySecret,
          privateKeyBytes,
          pubkeyHex!
        );
      } catch (err) {
        setSessionNotice(
          `Failed to publish new player ID: ${err instanceof Error ? err.message : "Unknown error"}`
        );
        setSessionStatus("idle");
        return false;
      }

      // Set new player id
      setPlayerId(newPlayerId);

      // Derive new encryption keys
      const keys = await deriveEncryptionKey(newPlayerId);
      setEncryptionKeys(keys);

      setSessionStatus("idle");
      setSessionNotice("Player ID rotated. Previous history is no longer accessible.");

      return true;
    },
    [pubkeyHex, fingerprint, secondarySecret]
  );

  const startTakeoverGrace = useCallback(() => {
    setIgnoreRemoteUntil(Date.now() + takeoverGraceMs);
  }, [takeoverGraceMs]);

  const clearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  return {
    npub,
    pubkeyHex,
    playerId,
    encryptionKeys,
    secondarySecret,
    sessionStatus,
    sessionNotice,
    localSessionId,
    ignoreRemoteUntil,
    setSessionStatus,
    setSessionNotice,
    clearSessionNotice,
    startTakeoverGrace,
    generateNewIdentity,
    submitSecondarySecret,
    setupWithNsec,
    rotatePlayerId,
  };
}
