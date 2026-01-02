import { useCallback, useEffect, useRef, useState } from "react";
import { deriveNostrKeys } from "@/lib/nostr-crypto";
import { loadHistoryFromNostr, subscribeToHistory } from "@/lib/nostr-sync";

export type SessionStatus = "unclaimed" | "active" | "stale" | "unknown";

interface UseNostrSessionOptions {
  sessionId?: string;
  onSessionStatusChange?: (status: SessionStatus) => void;
  takeoverGraceMs?: number;
  pollMs?: number;
}

interface UseNostrSessionResult {
  secret: string;
  sessionStatus: SessionStatus;
  sessionNotice: string | null;
  localSessionId: string;
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;
}

interface CachedKeys {
  privateKey: Uint8Array;
  publicKey: string;
}

const DEFAULT_TAKEOVER_GRACE_MS = 15000;
const DEFAULT_SESSION_POLL_MS = 6000;

function getSecretFromHash(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash;
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

export function useNostrSession({
  sessionId,
  onSessionStatusChange,
  takeoverGraceMs = DEFAULT_TAKEOVER_GRACE_MS,
  pollMs = DEFAULT_SESSION_POLL_MS,
}: UseNostrSessionOptions): UseNostrSessionResult {
  const [secret, setSecret] = useState(getSecretFromHash());
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("unknown");
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [localSessionId] = useState(() => sessionId ?? crypto.randomUUID());

  const ignoreRemoteUntilRef = useRef<number>(0);
  const keysRef = useRef<CachedKeys | null>(null);
  const prevStatusRef = useRef<SessionStatus>(sessionStatus);
  const staleNoticeTimerRef = useRef<number | null>(null);

  const onSessionStatusChangeRef = useRef(onSessionStatusChange);

  useEffect(() => {
    onSessionStatusChangeRef.current = onSessionStatusChange;
  }, [onSessionStatusChange]);

  useEffect(() => {
    if (sessionStatus === "unknown") return;
    onSessionStatusChangeRef.current?.(sessionStatus);
  }, [sessionStatus]);

  useEffect(() => {
    if (prevStatusRef.current !== "stale" && sessionStatus === "stale") {
      if (staleNoticeTimerRef.current) {
        clearTimeout(staleNoticeTimerRef.current);
      }
      staleNoticeTimerRef.current = window.setTimeout(() => {
        setSessionNotice("Session taken over by another device.");
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

  // Sync secret with URL hash changes
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHashChange = () => {
      const newSecret = getSecretFromHash();
      setSecret(newSecret);
      if (!newSecret) {
        setSessionStatus("unknown");
        setSessionNotice(null);
      }
    };

    window.addEventListener("hashchange", handleHashChange);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    keysRef.current = null;
    if (!secret) return;
    void deriveNostrKeys(secret)
      .then((keys) => {
        if (!cancelled) {
          keysRef.current = keys;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("Failed to derive Nostr keys for polling:", err);
        }
      });

    return () => {
      cancelled = true;
      keysRef.current = null;
    };
  }, [secret]);

  const startTakeoverGrace = useCallback(() => {
    ignoreRemoteUntilRef.current = Date.now() + takeoverGraceMs;
  }, [takeoverGraceMs]);

  const clearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  // Subscription for "Stale" detection
  useEffect(() => {
    if (!secret) return;

    const setupSubscription = async () => {
      const keys = await deriveNostrKeys(secret);
      if (cancelled) return null;
      const cleanup = subscribeToHistory(keys.publicKey, (remoteSid) => {
        if (cancelled) return;
          // If we see a session ID that is NOT ours, we are stale.
          if (remoteSid && remoteSid !== localSessionId) {
            if (Date.now() < ignoreRemoteUntilRef.current) return;
          setSessionStatus((prev) => (prev === "stale" ? prev : "stale"));
        } else if (remoteSid === localSessionId) {
          setSessionStatus("active");
          setSessionNotice(null);
        }
      });
      return cleanup;
    };

    let cancelled = false;
    const cleanupPromise = setupSubscription().catch((err) => {
      if (!cancelled) {
        console.error("Failed to setup Nostr subscription:", err);
      }
      return null;
    });

    return () => {
      cancelled = true;
      void cleanupPromise
        .then((cleanup) => {
          if (cleanup) cleanup();
        })
        .catch(() => {
          // Ignore subscription setup failures on teardown.
        });
    };
  }, [secret, localSessionId]);

  // Fallback polling to detect session changes if relay subscription misses events
  useEffect(() => {
    if (!secret || sessionStatus !== "active") return;

    let cancelled = false;
    const checkSession = async () => {
      try {
        const keys = keysRef.current;
        if (!keys) return;
        const cloudData = await loadHistoryFromNostr(
          keys.privateKey,
          keys.publicKey
        );
        if (cancelled || !cloudData?.sessionId) return;
        if (cloudData.sessionId !== localSessionId) {
          if (Date.now() < ignoreRemoteUntilRef.current) return;
          setSessionStatus("stale");
        }
      } catch (err) {
        console.debug("Polling error in useNostrSession:", err);
        // Ignore polling errors to avoid noisy UI updates
      }
    };

    void checkSession();
    const intervalId = window.setInterval(checkSession, pollMs);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [secret, sessionStatus, localSessionId, pollMs]);

  return {
    secret,
    sessionStatus,
    sessionNotice,
    localSessionId,
    setSessionStatus,
    setSessionNotice,
    clearSessionNotice,
    startTakeoverGrace,
  };
}
