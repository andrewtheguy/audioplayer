import { useCallback, useEffect, useRef, useState } from "react";
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
  // Keys derived from player id - used for both encryption/decryption AND signing
  encryptionKeys: { privateKey: Uint8Array; publicKey: string } | null;
  localSessionId: string;
  sessionStatus: SessionStatus;
  setSessionStatus: (status: SessionStatus) => void;
  setSessionNotice: (notice: string | null) => void;
  clearSessionNotice: () => void;
  startTakeoverGrace: () => void;
  ignoreRemoteUntil: number;
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
  isPlayingRef?: React.RefObject<boolean>;
  debounceSaveMs?: number;
  positionSaveIntervalMs?: number;
  operationTimeoutMs?: number;
}

interface UseNostrSyncResult {
  status: SyncStatus;
  message: string | null;
  lastOperation: LastOperation | null;
  setMessage: (message: string | null) => void;
  performSave: (
    historyToSave: HistoryEntry[],
    options?: { allowStale?: boolean }
  ) => Promise<boolean>;
  performLoad: (
    isTakeOver?: boolean,
    options?: { followRemote?: boolean; silent?: boolean }
  ) => Promise<void>;
  performInitialLoad: () => Promise<void>;
  startSession: () => Promise<void>;
}

const DEFAULT_DEBOUNCE_SAVE_MS = 5000;
const DEFAULT_POSITION_SAVE_INTERVAL_MS = 5000;
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

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

function getFingerprint(pubkeyHex: string): string {
  return `${pubkeyHex.slice(0, 4).toUpperCase()}-${pubkeyHex.slice(4, 8).toUpperCase()}`;
}

export function useNostrSync({
  history,
  encryptionKeys,
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

  // NostrPad-style refs for reliable syncing
  const latestTimestampRef = useRef<number>(0);
  const isLocalChangeRef = useRef<boolean>(false);
  const pendingPublishRef = useRef<boolean>(false);
  const ignoreRemoteUntilRef = useRef<number>(ignoreRemoteUntil);

  // Ref for encryption keys (derived from player id)
  const encryptionKeysRef = useRef(encryptionKeys);

  const isActive = useCallback(
    () => mountedRef.current && !abortRef.current?.signal.aborted,
    []
  );

  const canSync = useCallback(() => !!encryptionKeysRef.current, []);

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
    encryptionKeysRef.current = encryptionKeys;
  }, [encryptionKeys]);

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
      historyToSave: HistoryEntry[],
      options?: { allowStale?: boolean; silent?: boolean }
    ) => {
      if (!canSync() || !isActive()) return false;
      if (pendingPublishRef.current) return false;
      const signal = abortRef.current?.signal;
      if (signal?.aborted) return false;

      const keys = encryptionKeysRef.current;

      if (!keys) {
        console.warn("[nostr-sync] Cannot save: missing keys");
        return false;
      }

      const shouldBlockSave = () =>
        sessionStatusRef.current === "stale" && !options?.allowStale;

      if (shouldBlockSave()) {
        console.warn("Attempted to save while stale. Ignoring.");
        return false;
      }

      pendingPublishRef.current = true;

      try {
        if (shouldBlockSave()) {
          console.warn("Session became stale before save. Ignoring.");
          return false;
        }
        if (!options?.silent) {
          setStatus("saving");
        }
        await withTimeout(
          saveHistoryToNostr(historyToSave, keys, localSessionId, signal),
          operationTimeoutMs
        );
        if (!isActive()) return false;

        latestTimestampRef.current = Date.now();

        const fingerprint = getFingerprint(keys.publicKey);
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
    [canSync, isActive, localSessionId, operationTimeoutMs]
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
      const result = mergeHistory(historyRef.current, cloudHistory);
      skipNextDirtyRef.current = true;
      onHistoryLoadedRef.current(result.merged);
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
    async (
      result: { merged: HistoryEntry[]; addedFromCloud: number },
      isTakeOver: boolean,
      remoteSid?: string,
      isStaleRemote?: boolean
    ) => {
      if (!isActive()) return;

      const willSave = isTakeOver || !remoteSid || remoteSid === localSessionId;
      const needsSave = willSave && (isTakeOver || !remoteSid);

      // Only set dirtyRef = false immediately if we're not going to save
      // If we're saving, let performSave handle clearing dirtyRef on success
      if (!needsSave) {
        dirtyRef.current = false;
      }

      setStatus("success");
      if (!isStaleRemote) {
        setMessage(
          result.addedFromCloud > 0
            ? `Added ${result.addedFromCloud} entries from cloud`
            : "History is up to date"
        );
      }

      if (willSave) {
        setSessionStatus("active");
        clearSessionNotice();
        if (needsSave) {
          await performSave(result.merged, { allowStale: isTakeOver });
          // dirtyRef is cleared by performSave on success, remains true on failure for retry
        }
      }
    },
    [clearSessionNotice, isActive, localSessionId, performSave, setSessionStatus]
  );

  const performLoad = useCallback(
    async (
      isTakeOver = false,
      options?: { followRemote?: boolean; silent?: boolean }
    ) => {
      if (!canSync() || !isActive()) return;
      const signal = abortRef.current?.signal;
      if (signal?.aborted) return;

      const keys = encryptionKeysRef.current;

      if (!keys) {
        console.warn("[nostr-sync] Cannot load: missing keys");
        return;
      }

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
        const cloudData = await withTimeout(
          loadHistoryFromNostr(keys, signal),
          operationTimeoutMs
        );
        if (!isActive()) return;

        const fingerprint = getFingerprint(keys.publicKey);
        if (!isActive()) return;
        setLastOperation({
          type: "loaded",
          fingerprint,
          timestamp: formatTimestamp(new Date()),
        });

        if (cloudData) {
          const { history: cloudHistory, sessionId: remoteSid, timestamp } = cloudData;
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
          await updateSessionStateAndMaybeSave(
            result,
            isTakeOver,
            remoteSid ?? undefined,
            isStaleRemote
          );
        } else {
          if (!isActive()) return;
          setSessionStatus("active");
          clearSessionNotice();

          // Sync local history to Nostr if we have any
          const localHistory = historyRef.current;
          if (localHistory.length > 0) {
            if (!silent) {
              setMessage(`Syncing ${localHistory.length} local entries...`);
            }
            const saved = await performSave(localHistory, { allowStale: true });
            if (!isActive()) return;
            if (saved) {
              if (!silent) {
                setStatus("success");
                setMessage("Session started");
              }
              // dirtyRef is cleared by performSave on success
            }
            // If save failed, performSave already set error status and dirtyRef remains true for retry
          } else {
            if (!silent) {
              setStatus("success");
              setMessage("Session started (new)");
            }
            dirtyRef.current = false;
          }
        }
      } catch (err) {
        if (!isActive()) return;
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
      canSync,
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

  const performInitialLoad = useCallback(async () => {
    if (!canSync() || !isActive()) return;
    const signal = abortRef.current?.signal;
    if (signal?.aborted) return;

    const keys = encryptionKeysRef.current;

    if (!keys) {
      return;
    }

    setStatus("loading");
    setMessage("Loading history...");

    try {
      const cloudData = await withTimeout(
        loadHistoryFromNostr(keys, signal),
        operationTimeoutMs
      );
      if (!isActive()) return;

      const fingerprint = getFingerprint(keys.publicKey);
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
        const result = mergeHistory(historyRef.current, cloudHistory);
        skipNextDirtyRef.current = true;
        onHistoryLoadedRef.current(result.merged);
        setStatus("success");
        setMessage(`Loaded ${cloudHistory.length} entries`);
        dirtyRef.current = false;
      } else {
        // No remote history found - sync local history to Nostr if we have any
        const localHistory = historyRef.current;
        if (localHistory.length > 0) {
          setMessage(`Syncing ${localHistory.length} local entries...`);
          const saved = await performSave(localHistory, { allowStale: true });
          if (!isActive()) return;
          if (saved) {
            setStatus("success");
            setMessage(`Synced ${localHistory.length} local entries`);
            // dirtyRef is cleared by performSave on success
          }
          // If save failed, performSave already set error status and dirtyRef remains true for retry
        } else {
          setStatus("success");
          setMessage("No synced history found.");
          dirtyRef.current = false;
        }
      }
    } catch (err) {
      if (!isActive()) return;
      setStatus("error");
      if (err instanceof TimeoutError) {
        setMessage("Load timed out. Check your connection.");
      } else {
        setMessage(err instanceof Error ? err.message : "Failed to load");
      }
    }
  }, [canSync, isActive, operationTimeoutMs, performSave]);

  const startSession = useCallback(async () => {
    if (!canSync() || !isActive()) return;
    await performLoad(true);
  }, [canSync, isActive, performLoad]);

  // Handle remote events
  const handleRemoteEvent = useCallback(
    (payload: HistoryPayload) => {
      // Ignore events while we're publishing to avoid processing our own echoed events
      if (pendingPublishRef.current || isLocalChangeRef.current) return;
      // Ignore our own events
      if (payload.sessionId && payload.sessionId === localSessionId) return;
      // Ignore stale events (already processed or older than our last save)
      if (payload.timestamp <= latestTimestampRef.current) return;
      latestTimestampRef.current = payload.timestamp;
      // Ignore during takeover grace period
      if (Date.now() < ignoreRemoteUntilRef.current) return;

      if (payload.sessionId && payload.sessionId !== localSessionId) {
        if (sessionStatusRef.current === "active") {
          setSessionStatus("stale");
          setSessionNotice("Another device is now active.");
        }
      }

      const result = mergeHistory(historyRef.current, payload.history);
      skipNextDirtyRef.current = true;
      onHistoryLoadedRef.current(result.merged);
      if (sessionStatusRef.current === "stale" || sessionStatusRef.current === "idle") {
        onRemoteSyncRef.current?.(result.merged);
      }
    },
    [localSessionId, setSessionNotice, setSessionStatus]
  );

  // Subscribe to history updates when we have encryption keys
  useEffect(() => {
    if (!encryptionKeys) return;
    let cancelled = false;

    const cleanup = subscribeToHistoryDetailed(encryptionKeys, (payload) => {
      if (cancelled) return;
      handleRemoteEvent(payload);
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [encryptionKeys, handleRemoteEvent]);

  // Check session validity on visibility change
  useEffect(() => {
    if (!encryptionKeys) return;

    const checkSessionValidity = async () => {
      if (sessionStatusRef.current !== "active") return;

      try {
        const cloudData = await loadHistoryFromNostr(encryptionKeys);

        if (cloudData) {
          const { sessionId: remoteSid, timestamp } = cloudData;
          if (remoteSid && remoteSid !== localSessionId) {
            if (timestamp > latestTimestampRef.current) {
              latestTimestampRef.current = timestamp;
              handleStaleSession();
            }
          }
        }
      } catch (err) {
        console.error("[nostr-sync] Failed to check session validity:", err);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkSessionValidity();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [encryptionKeys, localSessionId, handleStaleSession]);

  // Auto-save when history changes (debounced)
  useEffect(() => {
    if (!canSync() || sessionStatus !== "active" || !dirtyRef.current) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(() => {
      void performSave(history);
    }, debounceSaveMs);

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [history, sessionStatus, performSave, debounceSaveMs, canSync]);

  // Frequent position updates during active playback
  useEffect(() => {
    if (!canSync() || sessionStatus !== "active") return;
    if (!isPlayingRef) return;

    const intervalId = window.setInterval(() => {
      if (isPlayingRef.current && !pendingPublishRef.current) {
        isLocalChangeRef.current = true;
        void performSave(historyRef.current, { silent: true });
      }
    }, positionSaveIntervalMs);

    return () => {
      clearInterval(intervalId);
    };
  }, [sessionStatus, isPlayingRef, positionSaveIntervalMs, performSave, canSync]);

  // Initial load when keys become available
  useEffect(() => {
    if (!encryptionKeys) return;
    if (sessionStatusRef.current === "idle") {
      void performInitialLoad();
    }
  }, [encryptionKeys, performInitialLoad]);

  return {
    status: canSync() ? status : "idle",
    message: canSync() ? message : null,
    lastOperation: canSync() ? lastOperation : null,
    setMessage,
    performSave,
    performLoad,
    performInitialLoad,
    startSession,
  };
}

export type { SyncStatus, LastOperation };
