import { useCallback, useEffect, useRef, useState } from "react";
import { isValidSecret } from "@/lib/nostr-crypto";
import { saveLastUsedSecret, getSessionState, getSecretKeyPrefix } from "@/lib/history";

export type SessionStatus = "idle" | "active" | "stale" | "invalid" | "unknown";

interface UseNostrSessionOptions {
  sessionId?: string;
  onSessionStatusChange?: (status: SessionStatus) => void;
  takeoverGraceMs?: number;
}

interface UseNostrSessionResult {
  secret: string;
  sessionStatus: SessionStatus;
  sessionNotice: string | null;
  localSessionId: string;
  ignoreRemoteUntil: number; // Grace period timestamp for useNostrSync
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;
}

const DEFAULT_TAKEOVER_GRACE_MS = 15000;

function getSecretFromHash(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash;
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

function getInitialStatus(secret: string): SessionStatus {
  if (!secret) return "unknown";
  if (!isValidSecret(secret)) return "invalid";
  return "idle";
}

function getInitialNotice(status: SessionStatus): string | null {
  if (status === "invalid") {
    return "Invalid secret link. Check for typos in the URL.";
  }
  return null;
}

function computeInitialState() {
  const secret = getSecretFromHash();
  const status = getInitialStatus(secret);
  const notice = getInitialNotice(status);
  // Try to restore sessionId from sessionStorage for this secret
  let restoredSessionId: string | null = null;
  if (secret && status !== "invalid") {
    const keyPrefix = getSecretKeyPrefix(secret);
    const savedState = getSessionState(keyPrefix);
    if (savedState) {
      restoredSessionId = savedState.sessionId;
    }
  }
  return { secret, status, notice, restoredSessionId };
}

export function useNostrSession({
  sessionId,
  onSessionStatusChange,
  takeoverGraceMs = DEFAULT_TAKEOVER_GRACE_MS,
}: UseNostrSessionOptions): UseNostrSessionResult {
  // Compute initial state once using lazy initializer pattern.
  // Each useState shares the same computed object via closure.
  const [initial] = useState(computeInitialState);
  const [secret, setSecret] = useState(initial.secret);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>(initial.status);
  const [sessionNotice, setSessionNotice] = useState<string | null>(initial.notice);
  // Use restored sessionId from sessionStorage if available, otherwise generate new
  // This needs to be updatable when secret changes via hash navigation
  const [localSessionId, setLocalSessionId] = useState(
    () => sessionId ?? initial.restoredSessionId ?? crypto.randomUUID()
  );
  const [ignoreRemoteUntil, setIgnoreRemoteUntil] = useState<number>(0);

  const prevStatusRef = useRef<SessionStatus>(sessionStatus);
  const staleNoticeTimerRef = useRef<number | null>(null);

  const onSessionStatusChangeRef = useRef(onSessionStatusChange);

  useEffect(() => {
    onSessionStatusChangeRef.current = onSessionStatusChange;
  }, [onSessionStatusChange]);

  useEffect(() => {
    // Save secret to localStorage when session becomes active
    if (sessionStatus === "active" && secret) {
      saveLastUsedSecret(secret);
    }
  }, [sessionStatus, secret]);

  useEffect(() => {
    onSessionStatusChangeRef.current?.(sessionStatus);
  }, [sessionStatus]);

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

  // Sync secret with URL hash changes
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHashChange = () => {
      const newSecret = getSecretFromHash();
      setSecret(newSecret);
      const newStatus = getInitialStatus(newSecret);
      setSessionStatus(newStatus);
      if (newStatus === "invalid") {
        setSessionNotice("Invalid secret link. Check for typos in the URL.");
      } else {
        setSessionNotice(null);
      }
      // Update localSessionId when secret changes - restore from sessionStorage or generate new
      if (newSecret && newStatus !== "invalid") {
        const keyPrefix = getSecretKeyPrefix(newSecret);
        const savedState = getSessionState(keyPrefix);
        if (savedState) {
          setLocalSessionId(savedState.sessionId);
        } else {
          setLocalSessionId(crypto.randomUUID());
        }
      }
    };

    window.addEventListener("hashchange", handleHashChange);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  const startTakeoverGrace = useCallback(() => {
    setIgnoreRemoteUntil(Date.now() + takeoverGraceMs);
  }, [takeoverGraceMs]);

  const clearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  // Session detection is now handled by useNostrSync subscription with timestamp-based ordering

  return {
    secret,
    sessionStatus,
    sessionNotice,
    localSessionId,
    ignoreRemoteUntil,
    setSessionStatus,
    setSessionNotice,
    clearSessionNotice,
    startTakeoverGrace,
  };
}
