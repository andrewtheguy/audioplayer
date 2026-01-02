import { useEffect, useRef, useState } from "react";
import { deriveNostrKeys } from "@/lib/pin-crypto";
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

  useEffect(() => {
    onSessionStatusChange?.(sessionStatus);
  }, [sessionStatus, onSessionStatusChange]);

  // Sync secret with URL hash changes
  useEffect(() => {
    const handleHashChange = () => {
      const newSecret = getSecretFromHash();
      setSecret(newSecret);
      if (!newSecret) {
        setSessionStatus("unknown");
        setSessionNotice(null);
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    const initialSecret = getSecretFromHash();
    setSecret(initialSecret);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const startTakeoverGrace = () => {
    ignoreRemoteUntilRef.current = Date.now() + takeoverGraceMs;
  };

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
          setSessionStatus((prev) => {
            if (prev !== "stale") {
              setSessionNotice("Session taken over by another device.");
              return "stale";
            }
            return prev;
          });
        } else if (remoteSid === localSessionId) {
          setSessionStatus("active");
          setSessionNotice(null);
        }
      });
      return cleanup;
    };

    let cancelled = false;
    const cleanupPromise = setupSubscription();

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
        const keys = await deriveNostrKeys(secret);
        const cloudData = await loadHistoryFromNostr(
          keys.privateKey,
          keys.publicKey
        );
        if (cancelled || !cloudData?.sessionId) return;
        if (cloudData.sessionId !== localSessionId) {
          if (Date.now() < ignoreRemoteUntilRef.current) return;
          setSessionStatus("stale");
          setSessionNotice("Session taken over by another device.");
        }
      } catch (err) {
        console.debug("Polling error in useNostrSession:", err);
        // Ignore polling errors to avoid noisy UI updates
      }
    };

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
    clearSessionNotice: () => setSessionNotice(null),
    startTakeoverGrace,
  };
}
