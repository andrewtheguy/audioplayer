import { useCallback, useEffect, useRef, useState } from "react";
import { getPublicKey } from "nostr-tools/pure";
import {
  parseNpub,
  decodeNsec,
  generatePlayerId,
  isValidPlayerId,
  generateSecondarySecret,
  isValidSecondarySecret,
  generateNostrKeypair,
  deriveEncryptionKey,
  generateSessionId,
} from "@/lib/nostr-crypto";
import {
  setSecondarySecret,
} from "@/lib/identity";
import {
  loadPlayerIdFromNostr,
  publishPlayerIdToNostr,
  PlayerIdDecryptionError,
} from "@/lib/nostr-sync";
import { useAuth } from "@/contexts/AuthContext";

export type SessionStatus =
  | "loading" // Fetching player id from relay
  | "needs_setup" // No player id exists, needs nsec to create initial one
  | "idle" // Ready, has player id, not started
  | "active" // Active session on this device
  | "stale"; // Another device took over

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
  setupWithNsec: (nsec: string, newSecondarySecret?: string) => Promise<boolean>;
  rotatePlayerId: (nsec: string) => Promise<boolean>;
}

const DEFAULT_TAKEOVER_GRACE_MS = 15000;

export function useNostrSession({
  sessionId,
  onSessionStatusChange,
  takeoverGraceMs = DEFAULT_TAKEOVER_GRACE_MS,
}: UseNostrSessionOptions = {}): UseNostrSessionResult {
  // Get auth state from context
  const { npub: authNpub, pubkeyHex: authPubkeyHex, secondarySecret: authSecondarySecret } = useAuth();

  // Player ID and encryption keys (combined for atomic updates)
  const [playerState, setPlayerState] = useState<{
    playerId: string | null;
    encryptionKeys: { privateKey: Uint8Array; publicKey: string } | null;
  }>({ playerId: null, encryptionKeys: null });
  const { playerId, encryptionKeys } = playerState;

  // Session state
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("loading");
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [localSessionId] = useState(() => sessionId ?? generateSessionId());
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

  // Initialize session when auth state changes
  const initializeSession = useCallback(async () => {
    if (initializingRef.current) return;
    if (!authNpub || !authPubkeyHex || !authSecondarySecret) {
      // Not logged in - reset state
      setPlayerState({ playerId: null, encryptionKeys: null });
      setSessionStatus("loading");
      return;
    }

    initializingRef.current = true;

    // Reset player state at start of initialization (atomic)
    setPlayerState({ playerId: null, encryptionKeys: null });

    try {
      // Try to load player id from relay
      setSessionStatus("loading");
      try {
        const remotePlayerId = await loadPlayerIdFromNostr(authPubkeyHex, authSecondarySecret);
        if (remotePlayerId && isValidPlayerId(remotePlayerId)) {
          const keys = await deriveEncryptionKey(remotePlayerId);
          setPlayerState({ playerId: remotePlayerId, encryptionKeys: keys });
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
          setSessionNotice("Wrong secondary secret. Please log out and try again.");
          setSessionStatus("needs_setup");
          return;
        }
        // Network or other error
        console.warn("Failed to load player id from relay:", err);
        setSessionNotice(
          `Network error: ${err instanceof Error ? err.message : "Failed to connect to relay"}. Please try again.`
        );
        setSessionStatus("needs_setup");
        return;
      }
    } finally {
      initializingRef.current = false;
    }
  }, [authNpub, authPubkeyHex, authSecondarySecret]);

  // Run initialization when auth state changes
  useEffect(() => {
    initializeSession();
  }, [initializeSession]);

  // Periodic revalidation of player ID (detect rotation by another device)
  useEffect(() => {
    // Only validate when session is active or idle
    if (sessionStatus !== "idle" && sessionStatus !== "active") return;
    if (!authPubkeyHex || !authSecondarySecret || !playerId) return;

    const REVALIDATION_INTERVAL_MS = 30000; // 30 seconds

    const revalidate = async () => {
      try {
        const remotePlayerId = await loadPlayerIdFromNostr(authPubkeyHex, authSecondarySecret);

        if (!remotePlayerId) {
          // Player ID was deleted - shouldn't normally happen
          console.warn("Player ID no longer exists on relay");
          return;
        }

        if (remotePlayerId !== playerId) {
          // Player ID changed - this means rotation happened with same secret
          // (unusual, but handle it)
          console.warn("Player ID changed on relay, re-initializing");
          const keys = await deriveEncryptionKey(remotePlayerId);
          setPlayerState({ playerId: remotePlayerId, encryptionKeys: keys });
        }
      } catch (err) {
        if (err instanceof PlayerIdDecryptionError) {
          // Decryption failed - credentials were rotated
          console.warn("Player ID decryption failed - credentials rotated");
          setPlayerState({ playerId: null, encryptionKeys: null });
          setSessionStatus("needs_setup");
          setSessionNotice("Credentials were rotated. Please log out and log in with new credentials.");
        } else {
          // Network error - ignore, will retry on next interval
          console.warn("Failed to revalidate player ID:", err);
        }
      }
    };

    const intervalId = window.setInterval(revalidate, REVALIDATION_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [sessionStatus, authPubkeyHex, authSecondarySecret, playerId]);

  // Generate new identity (npub/nsec pair)
  const generateNewIdentity = useCallback(async (): Promise<{
    npub: string;
    nsec: string;
  }> => {
    const keypair = generateNostrKeypair();
    return {
      npub: keypair.npub,
      nsec: keypair.nsec,
    };
  }, []);

  // Setup with nsec (create initial player id)
  const setupWithNsec = useCallback(
    async (nsec: string, newSecondarySecret?: string): Promise<boolean> => {
      // Decode nsec
      const privateKeyBytes = decodeNsec(nsec);
      if (!privateKeyBytes) {
        setSessionNotice("Invalid nsec format.");
        return false;
      }

      // Derive pubkey from nsec
      const derivedPubkey = getPublicKey(privateKeyBytes);

      // Check if there's already an npub - if so, verify it matches
      if (authNpub) {
        const currentPubkey = parseNpub(authNpub);
        if (currentPubkey && currentPubkey !== derivedPubkey) {
          setSessionNotice("nsec does not match this identity.");
          return false;
        }
      }

      // Use provided secret or existing or generate new
      let secret = newSecondarySecret;
      if (!secret) {
        secret = authSecondarySecret || generateSecondarySecret();
      }

      if (!isValidSecondarySecret(secret)) {
        setSessionNotice("Invalid secondary secret format.");
        return false;
      }

      // Store the secret
      setSecondarySecret(secret);

      // Generate new player id
      const newPlayerId = generatePlayerId();

      // Publish to relay
      setSessionStatus("loading");
      try {
        await publishPlayerIdToNostr(
          newPlayerId,
          secret,
          privateKeyBytes,
          derivedPubkey
        );
      } catch (err) {
        setSessionNotice(
          `Failed to publish player ID: ${err instanceof Error ? err.message : "Unknown error"}`
        );
        setSessionStatus("needs_setup");
        return false;
      }

      // Derive encryption keys first, then set state atomically
      const keys = await deriveEncryptionKey(newPlayerId);
      setPlayerState({ playerId: newPlayerId, encryptionKeys: keys });

      setSessionStatus("idle");
      setSessionNotice(null);

      return true;
    },
    [authNpub, authSecondarySecret]
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

      // Verify identity exists
      if (!authPubkeyHex) {
        setSessionNotice("No identity found. Please log in first.");
        return false;
      }

      // Verify nsec matches npub
      const derivedPubkey = getPublicKey(privateKeyBytes);
      if (derivedPubkey !== authPubkeyHex) {
        setSessionNotice("nsec does not match this identity.");
        return false;
      }

      if (!authSecondarySecret) {
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
          authSecondarySecret,
          privateKeyBytes,
          authPubkeyHex
        );
      } catch (err) {
        setSessionNotice(
          `Failed to publish new player ID: ${err instanceof Error ? err.message : "Unknown error"}`
        );
        setSessionStatus("idle");
        return false;
      }

      // Derive encryption keys first, then set state atomically
      const keys = await deriveEncryptionKey(newPlayerId);
      setPlayerState({ playerId: newPlayerId, encryptionKeys: keys });

      setSessionStatus("idle");
      setSessionNotice("Player ID rotated. Previous history is no longer accessible.");

      return true;
    },
    [authPubkeyHex, authSecondarySecret]
  );

  const startTakeoverGrace = useCallback(() => {
    setIgnoreRemoteUntil(Date.now() + takeoverGraceMs);
  }, [takeoverGraceMs]);

  const clearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  return {
    npub: authNpub,
    pubkeyHex: authPubkeyHex,
    playerId,
    encryptionKeys,
    secondarySecret: authSecondarySecret,
    sessionStatus,
    sessionNotice,
    localSessionId,
    ignoreRemoteUntil,
    setSessionStatus,
    setSessionNotice,
    clearSessionNotice,
    startTakeoverGrace,
    generateNewIdentity,
    setupWithNsec,
    rotatePlayerId,
  };
}
