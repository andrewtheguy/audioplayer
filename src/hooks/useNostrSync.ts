import { useCallback, useEffect, useRef, useState } from "react";
import { deriveNostrKeys } from "@/lib/nostr-crypto";
import {
  loadHistoryFromNostr,
  mergeHistory,
  saveHistoryToNostr,
  subscribeToHistoryDetailed,
} from "@/lib/nostr-sync";
import type { HistoryEntry, HistoryPayload } from "@/lib/history";
import type { SessionStatus } from "@/hooks/useNostrSession";

type SyncStatus = "idle" | "saving" | "loading" | "success" | "error";

interface LastOperation {
  type: "saved" | "loaded";
  fingerprint: string;
  timestamp: string;
}

interface UseNostrSyncOptions {
  history: HistoryEntry[];
  secret: string;
  localSessionId: string;
  sessionStatus: SessionStatus;
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;
  ignoreRemoteUntil: number; // Grace period timestamp from useNostrSession
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
  isPlayingRef?: React.RefObject<boolean>; // For frequent position updates during playback
  debounceSaveMs?: number;
  positionSaveIntervalMs?: number; // Interval for live position updates (default 1500ms)
  operationTimeoutMs?: number;
}

interface UseNostrSyncResult {
  status: SyncStatus;
  message: string | null;
  lastOperation: LastOperation | null;
  setMessage: (message: string | null) => void;
  performSave: (
    currentSecret: string,
    historyToSave: HistoryEntry[],
    options?: { allowStale?: boolean }
  ) => Promise<boolean>;
  performLoad: (
    currentSecret: string,
    isTakeOver?: boolean,
    options?: { followRemote?: boolean; silent?: boolean }
  ) => Promise<void>;
  performInitialLoad: (currentSecret: string) => Promise<void>;
  startSession: (currentSecret: string) => Promise<void>;
}

const DEFAULT_DEBOUNCE_SAVE_MS = 5000;
const DEFAULT_POSITION_SAVE_INTERVAL_MS = 5000; // Live position updates every 5s
const DEFAULT_OPERATION_TIMEOUT_MS = 30000;

class TimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new TimeoutError(`Operation timed out after ${ms / 1000}s`));
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
  });
}

async function getSecretFingerprint(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${hashHex.slice(0, 4)}-${hashHex.slice(4, 8)}`;
}

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export function useNostrSync({
  history,
  secret,
  localSessionId,
  sessionStatus,
  setSessionStatus,
  setSessionNotice,
  clearSessionNotice,
  startTakeoverGrace,
  ignoreRemoteUntil,
  onHistoryLoaded,
  onTakeOver,
  onRemoteSync,
  isPlayingRef,
  debounceSaveMs = DEFAULT_DEBOUNCE_SAVE_MS,
  positionSaveIntervalMs = DEFAULT_POSITION_SAVE_INTERVAL_MS,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
}: UseNostrSyncOptions): UseNostrSyncResult {
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [lastOperation, setLastOperation] = useState<LastOperation | null>(null);
  const dirtyRef = useRef(false);

  const historyRef = useRef(history);
  const onHistoryLoadedRef = useRef(onHistoryLoaded);
  const onTakeOverRef = useRef(onTakeOver);
  const onRemoteSyncRef = useRef(onRemoteSync);
  const sessionStatusRef = useRef(sessionStatus);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextDirtyRef = useRef(false);
  const hasMountedRef = useRef(false);
  const mountedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const performLoadRef = useRef<
    ((
      currentSecret: string,
      isTakeOver?: boolean,
      options?: { followRemote?: boolean; silent?: boolean }
    ) => Promise<void>) | null
  >(null);

  // NostrPad-style refs for reliable syncing
  const latestTimestampRef = useRef<number>(0); // Milliseconds from payload
  const isLocalChangeRef = useRef<boolean>(false); // Protect local changes during sync
  const pendingPublishRef = useRef<boolean>(false); // Prevent duplicate publishes
  const ignoreRemoteUntilRef = useRef<number>(ignoreRemoteUntil);

  const isActive = useCallback(
    () => mountedRef.current && !abortRef.current?.signal.aborted,
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    abortRef.current = new AbortController();
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    historyRef.current = history;
    onHistoryLoadedRef.current = onHistoryLoaded;
    onTakeOverRef.current = onTakeOver;
  }, [history, onHistoryLoaded, onTakeOver]);

  useEffect(() => {
    onRemoteSyncRef.current = onRemoteSync;
  }, [onRemoteSync]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

  useEffect(() => {
    ignoreRemoteUntilRef.current = ignoreRemoteUntil;
  }, [ignoreRemoteUntil]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      return;
    }
    if (skipNextDirtyRef.current) {
      skipNextDirtyRef.current = false;
      return;
    }
    dirtyRef.current = true;
  }, [history]);

  const performSave = useCallback(
    async (
      currentSecret: string,
      historyToSave: HistoryEntry[],
      options?: { allowStale?: boolean; silent?: boolean }
    ) => {
      if (!currentSecret || !isActive()) return false;
      if (pendingPublishRef.current) return false; // Prevent duplicate publishes
      const signal = abortRef.current?.signal;
      if (signal?.aborted) return false;

      const shouldBlockSave = () =>
        sessionStatusRef.current === "stale" && !options?.allowStale;

      if (shouldBlockSave()) {
        console.warn("Attempted to save while stale. Ignoring.");
        return false;
      }

      pendingPublishRef.current = true;

      try {
        const keys = await withTimeout(
          deriveNostrKeys(currentSecret, signal),
          operationTimeoutMs
        );
        if (!isActive()) return false;
        if (shouldBlockSave()) {
          console.warn("Session became stale before save. Ignoring.");
          return false;
        }
        if (!options?.silent) {
          setStatus("saving");
        }
        await withTimeout(
          saveHistoryToNostr(
            historyToSave,
            keys.privateKey,
            keys.publicKey,
            localSessionId,
            signal
          ),
          operationTimeoutMs
        );
        if (!isActive()) return false;

        // Update our timestamp ref to the time we just published
        latestTimestampRef.current = Date.now();

        const fingerprint = await getSecretFingerprint(currentSecret);
        if (!isActive()) return false;
        setLastOperation({
          type: "saved",
          fingerprint,
          timestamp: formatTimestamp(new Date()),
        });
        if (!options?.silent) {
          setStatus("success");
          setMessage(`Saved ${historyToSave.length} entries`);
        }
        dirtyRef.current = false;
        return true;
      } catch (err) {
        if (!isActive()) return false;
        if (!options?.silent) {
          setStatus("error");
          if (err instanceof TimeoutError) {
            setMessage("Save timed out. Check connection.");
          } else {
            setMessage(err instanceof Error ? err.message : "Failed to save");
          }
        }
        return false;
      } finally {
        isLocalChangeRef.current = false;
        pendingPublishRef.current = false;
      }
    },
    [isActive, localSessionId, operationTimeoutMs]
  );

  const detectStaleSession = useCallback(
    (isTakeOver: boolean, remoteSid?: string, localSid?: string) =>
      !isTakeOver && !!remoteSid && remoteSid !== localSid,
    []
  );

  const handleStaleSession = useCallback(() => {
    if (!isActive()) return;
    setSessionStatus("stale");
    setStatus("success");
    setSessionNotice(
      "Another session is active — viewing in read-only mode. Take over to edit."
    );
  }, [isActive, setSessionNotice, setSessionStatus]);

  const mergeAndNotify = useCallback(
    (cloudHistory: HistoryEntry[], isTakeOver: boolean, followRemote: boolean) => {
      const result = mergeHistory(historyRef.current, cloudHistory, {
        preferRemote: isTakeOver || followRemote,
        preferRemoteOrder: isTakeOver || followRemote,
      });
      skipNextDirtyRef.current = true;
      onHistoryLoadedRef.current(result.merged);
      // Only trigger onTakeOver when transitioning from a non-active state (actual device takeover)
      // This includes transitions from "stale" (read-only follower) and "idle" (no local session yet),
      // but avoids firing during already-active sessions to prevent unnecessary remounts.
      if (
        isTakeOver &&
        (sessionStatusRef.current === "stale" || sessionStatusRef.current === "idle")
      ) {
        onTakeOverRef.current?.(cloudHistory);
      }
      if (followRemote) {
        onRemoteSyncRef.current?.(result.merged);
      }
      return result;
    },
    []
  );

  const updateSessionStateAndMaybeSave = useCallback(
    (
      currentSecret: string,
      result: { merged: HistoryEntry[]; addedFromCloud: number },
      isTakeOver: boolean,
      remoteSid?: string,
      isStaleRemote?: boolean
    ) => {
      if (!isActive()) return;
      setStatus("success");
      dirtyRef.current = false;
      if (!isStaleRemote) {
        setMessage(
          result.addedFromCloud > 0
            ? `Added ${result.addedFromCloud} entries from cloud`
            : "History is up to date"
        );
      }

      if (isTakeOver || !remoteSid || remoteSid === localSessionId) {
        console.log("[nostr-sync] updateSessionStateAndMaybeSave: setting status to active");
        setSessionStatus("active");
        clearSessionNotice();
        if (isTakeOver || !remoteSid) {
          void performSave(currentSecret, result.merged, {
            allowStale: isTakeOver,
          });
        }
      }
    },
    [clearSessionNotice, isActive, localSessionId, performSave, setSessionStatus]
  );

  const performLoad = useCallback(
    async (
      currentSecret: string,
      isTakeOver = false,
      options?: { followRemote?: boolean; silent?: boolean }
    ) => {
      if (!currentSecret || !isActive()) return;
      const signal = abortRef.current?.signal;
      if (signal?.aborted) return;

      console.log("[nostr-sync] performLoad: starting, isTakeOver:", isTakeOver, "status:", sessionStatusRef.current);
      const followRemote = options?.followRemote === true;
      const silent = options?.silent === true;
      if (!silent) {
        setStatus("loading");
        setMessage("Syncing...");
      }
      if (isTakeOver) {
        startTakeoverGrace();
      }

      try {
        const keys = await withTimeout(
          deriveNostrKeys(currentSecret, signal),
          operationTimeoutMs
        );
        if (!isActive()) return;
        const cloudData = await withTimeout(
          loadHistoryFromNostr(keys.privateKey, keys.publicKey, signal),
          operationTimeoutMs
        );
        if (!isActive()) return;

        const fingerprint = await getSecretFingerprint(currentSecret);
        if (!isActive()) return;
        setLastOperation({
          type: "loaded",
          fingerprint,
          timestamp: formatTimestamp(new Date()),
        });

        if (cloudData) {
          const { history: cloudHistory, sessionId: remoteSid, timestamp } = cloudData;
          // Use payload timestamp (milliseconds) for ordering
          if (timestamp > latestTimestampRef.current) {
            latestTimestampRef.current = timestamp;
          } else if (followRemote) {
            return;
          }

          const isStaleRemote = detectStaleSession(
            isTakeOver,
            remoteSid ?? undefined,
            localSessionId
          );
          if (isStaleRemote) {
            handleStaleSession();
          }

          const result = mergeAndNotify(cloudHistory, isTakeOver, followRemote);
          if (!isActive()) return;
          updateSessionStateAndMaybeSave(
            currentSecret,
            result,
            isTakeOver,
            remoteSid ?? undefined,
            isStaleRemote
          );
        } else {
          if (!isActive()) return;
          if (!silent) {
            setStatus("success");
          }
          setSessionStatus("active");
          clearSessionNotice();
          if (!silent) {
            setMessage("Session started (new)");
          }
          dirtyRef.current = false;
          void performSave(currentSecret, historyRef.current, { allowStale: true });
        }
      } catch (err) {
        if (!isActive()) {
          console.log("[nostr-sync] performLoad: aborted (component unmounted)");
          return;
        }
        console.error("[nostr-sync] performLoad: error", err);
        if (!silent) {
          setStatus("error");
          if (err instanceof TimeoutError) {
            setMessage("Load timed out. Check your connection and try again.");
          } else {
            setMessage(err instanceof Error ? err.message : "Failed to load");
          }
        }
      }
    },
    [
      clearSessionNotice,
      detectStaleSession,
      handleStaleSession,
      isActive,
      localSessionId,
      mergeAndNotify,
      operationTimeoutMs,
      performSave,
      updateSessionStateAndMaybeSave,
      setSessionStatus,
      startTakeoverGrace,
    ]
  );

  useEffect(() => {
    performLoadRef.current = performLoad;
  }, [performLoad]);

  // Initial load: fetch history read-only without claiming session (for idle state)
  const performInitialLoad = useCallback(
    async (currentSecret: string) => {
      if (!currentSecret || !isActive()) return;
      const signal = abortRef.current?.signal;
      if (signal?.aborted) return;

      console.log("[nostr-sync] performInitialLoad: starting");
      setStatus("loading");
      setMessage("Loading history...");

      try {
        const keys = await withTimeout(
          deriveNostrKeys(currentSecret, signal),
          operationTimeoutMs
        );
        if (!isActive()) return;
        const cloudData = await withTimeout(
          loadHistoryFromNostr(keys.privateKey, keys.publicKey, signal),
          operationTimeoutMs
        );
        if (!isActive()) return;

        const fingerprint = await getSecretFingerprint(currentSecret);
        if (!isActive()) return;
        setLastOperation({
          type: "loaded",
          fingerprint,
          timestamp: formatTimestamp(new Date()),
        });

        if (cloudData) {
          const { history: cloudHistory, timestamp } = cloudData;
          if (timestamp > latestTimestampRef.current) {
            latestTimestampRef.current = timestamp;
          }
          // Merge and display history (read-only, don't claim session)
          const result = mergeHistory(historyRef.current, cloudHistory, {
            preferRemote: true,
            preferRemoteOrder: true,
          });
          skipNextDirtyRef.current = true;
          onHistoryLoadedRef.current(result.merged);
          setStatus("success");
          setMessage(`Loaded ${cloudHistory.length} entries`);
        } else {
          setStatus("success");
          setMessage("No history found. Click Start Session to begin.");
        }
        dirtyRef.current = false;
      } catch (err) {
        if (!isActive()) return;
        setStatus("error");
        if (err instanceof TimeoutError) {
          setMessage("Load timed out. Check your connection.");
        } else {
          setMessage(err instanceof Error ? err.message : "Failed to load");
        }
      }
    },
    [isActive, operationTimeoutMs]
  );

  // Start session: claim the session and begin syncing
  const startSession = useCallback(
    async (currentSecret: string) => {
      if (!currentSecret || !isActive()) return;
      console.log("[nostr-sync] startSession: claiming session, current status:", sessionStatusRef.current);
      // Use performLoad with isTakeOver=true to claim the session
      await performLoad(currentSecret, true);
      console.log("[nostr-sync] startSession: complete, new status:", sessionStatusRef.current);
    },
    [isActive, performLoad]
  );

  const performInitialLoadRef = useRef<((currentSecret: string) => Promise<void>) | null>(null);

  useEffect(() => {
    performInitialLoadRef.current = performInitialLoad;
  }, [performInitialLoad]);

  // On secret change, do initial load (read-only) instead of claiming session
  useEffect(() => {
    if (!secret) return;
    if (sessionStatusRef.current === "idle") {
      void performInitialLoadRef.current?.(secret);
    }
  }, [secret]);

  // NostrPad-style event handler for subscription
  const handleRemoteEvent = useCallback(
    (payload: HistoryPayload) => {
      // Skip if this is our own session
      if (payload.sessionId && payload.sessionId === localSessionId) return;

      // Skip if older than what we have (timestamp-based ordering)
      if (payload.timestamp <= latestTimestampRef.current) return;

      // Always update timestamp ref to track newest seen timestamp, even if skipped
      latestTimestampRef.current = payload.timestamp;

      // Check grace period - ignore remote events during takeover grace
      if (Date.now() < ignoreRemoteUntilRef.current) return;

      // Check for session takeover - only transition to stale if currently active
      // (idle devices stay idle, they haven't claimed the session yet)
      if (payload.sessionId && payload.sessionId !== localSessionId) {
        if (sessionStatusRef.current === "active") {
          setSessionStatus("stale");
          setSessionNotice(
            "Another device is now active."
          );
        }
      }

      // Don't overwrite local changes in progress
      if (!isLocalChangeRef.current) {
        skipNextDirtyRef.current = true;
        onHistoryLoadedRef.current(payload.history);
        // Notify remote sync for both idle and stale devices (read-only viewers)
        if (sessionStatusRef.current === "stale" || sessionStatusRef.current === "idle") {
          onRemoteSyncRef.current?.(payload.history);
        }
      }
    },
    [localSessionId, setSessionNotice, setSessionStatus]
  );

  useEffect(() => {
    if (!secret) return;
    let cancelled = false;

    const setupSubscription = async () => {
      const keys = await withTimeout(
        deriveNostrKeys(secret),
        operationTimeoutMs
      );
      if (cancelled) return null;
      const cleanup = subscribeToHistoryDetailed(
        keys.publicKey,
        keys.privateKey,
        (payload) => {
          if (cancelled) return;
          handleRemoteEvent(payload);
        }
      );
      return cleanup;
    };

    const cleanupPromise = setupSubscription().catch((err) => {
      if (!cancelled) {
        console.error("Failed to setup sync subscription:", err);
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
  }, [secret, handleRemoteEvent, operationTimeoutMs]);

  // Auto-save when history changes (debounced)
  useEffect(() => {
    if (!secret || sessionStatus !== "active" || !dirtyRef.current) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(() => {
      void performSave(secret, history);
    }, debounceSaveMs);

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [history, secret, sessionStatus, performSave, debounceSaveMs]);

  // Frequent position updates during active playback (for live sync to slaves)
  useEffect(() => {
    if (!secret || sessionStatus !== "active") return;
    if (!isPlayingRef) return;

    const intervalId = window.setInterval(() => {
      if (isPlayingRef.current && !pendingPublishRef.current) {
        isLocalChangeRef.current = true;
        void performSave(secret, historyRef.current, { silent: true });
      }
    }, positionSaveIntervalMs);

    return () => {
      clearInterval(intervalId);
    };
  }, [secret, sessionStatus, isPlayingRef, positionSaveIntervalMs, performSave]);

  return {
    status: secret ? status : "idle",
    message: secret ? message : null,
    lastOperation: secret ? lastOperation : null,
    setMessage,
    performSave,
    performLoad,
    performInitialLoad,
    startSession,
  };
}

export type { SyncStatus, LastOperation };
