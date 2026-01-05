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
  // New identity-based props (playerId is used to derive encryptionKeys in useNostrSession)
  encryptionKeys: { privateKey: Uint8Array; publicKey: string } | null;
  pubkeyHex: string | null; // npub hex for filtering/authoring events
  userPrivateKey: Uint8Array | null; // nsec bytes for signing events
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
  pubkeyHex,
  userPrivateKey,
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

  // Refs for identity data
  const encryptionKeysRef = useRef(encryptionKeys);
  const pubkeyHexRef = useRef(pubkeyHex);
  const userPrivateKeyRef = useRef(userPrivateKey);

  const isActive = useCallback(
    () => mountedRef.current && !abortRef.current?.signal.aborted,
    []
  );

  const canSync = useCallback(
    () => !!encryptionKeysRef.current && !!pubkeyHexRef.current,
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
    encryptionKeysRef.current = encryptionKeys;
    pubkeyHexRef.current = pubkeyHex;
    userPrivateKeyRef.current = userPrivateKey;
  }, [encryptionKeys, pubkeyHex, userPrivateKey]);

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
      const pubkey = pubkeyHexRef.current;
      const signingKey = userPrivateKeyRef.current;

      if (!keys || !pubkey || !signingKey) {
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
          saveHistoryToNostr(
            historyToSave,
            keys.publicKey, // encryption public key (from player id)
            signingKey, // signing key (nsec)
            pubkey, // author public key (npub hex)
            localSessionId,
            signal
          ),
          operationTimeoutMs
        );
        if (!isActive()) return false;

        latestTimestampRef.current = Date.now();

        const fingerprint = getFingerprint(pubkey);
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
    (
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
        setSessionStatus("active");
        clearSessionNotice();
        if (isTakeOver || !remoteSid) {
          void performSave(result.merged, { allowStale: isTakeOver });
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
      const pubkey = pubkeyHexRef.current;

      if (!keys || !pubkey) {
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
          loadHistoryFromNostr(keys.privateKey, pubkey, signal),
          operationTimeoutMs
        );
        if (!isActive()) return;

        const fingerprint = getFingerprint(pubkey);
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
          updateSessionStateAndMaybeSave(
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
          void performSave(historyRef.current, { allowStale: true });
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
    const pubkey = pubkeyHexRef.current;

    if (!keys || !pubkey) {
      return;
    }

    setStatus("loading");
    setMessage("Loading history...");

    try {
      const cloudData = await withTimeout(
        loadHistoryFromNostr(keys.privateKey, pubkey, signal),
        operationTimeoutMs
      );
      if (!isActive()) return;

      const fingerprint = getFingerprint(pubkey);
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
      } else {
        setStatus("success");
        setMessage("No synced history found.");
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
  }, [canSync, isActive, operationTimeoutMs]);

  const startSession = useCallback(async () => {
    if (!canSync() || !isActive()) return;
    await performLoad(true);
  }, [canSync, isActive, performLoad]);

  // Handle remote events
  const handleRemoteEvent = useCallback(
    (payload: HistoryPayload) => {
      if (payload.sessionId && payload.sessionId === localSessionId) return;
      if (payload.timestamp <= latestTimestampRef.current) return;
      latestTimestampRef.current = payload.timestamp;
      if (Date.now() < ignoreRemoteUntilRef.current) return;

      if (payload.sessionId && payload.sessionId !== localSessionId) {
        if (sessionStatusRef.current === "active") {
          setSessionStatus("stale");
          setSessionNotice("Another device is now active.");
        }
      }

      if (!isLocalChangeRef.current) {
        const result = mergeHistory(historyRef.current, payload.history);
        skipNextDirtyRef.current = true;
        onHistoryLoadedRef.current(result.merged);
        if (sessionStatusRef.current === "stale" || sessionStatusRef.current === "idle") {
          onRemoteSyncRef.current?.(result.merged);
        }
      }
    },
    [localSessionId, setSessionNotice, setSessionStatus]
  );

  // Subscribe to history updates when we have encryption keys
  useEffect(() => {
    if (!encryptionKeys || !pubkeyHex) return;
    let cancelled = false;

    const cleanup = subscribeToHistoryDetailed(
      pubkeyHex,
      encryptionKeys.privateKey,
      (payload) => {
        if (cancelled) return;
        handleRemoteEvent(payload);
      }
    );

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [encryptionKeys, pubkeyHex, handleRemoteEvent]);

  // Check session validity on visibility change
  useEffect(() => {
    if (!encryptionKeys || !pubkeyHex) return;

    const checkSessionValidity = async () => {
      if (sessionStatusRef.current !== "active") return;

      try {
        const cloudData = await loadHistoryFromNostr(
          encryptionKeys.privateKey,
          pubkeyHex
        );

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
  }, [encryptionKeys, pubkeyHex, localSessionId, handleStaleSession]);

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
    if (!encryptionKeys || !pubkeyHex) return;
    if (sessionStatusRef.current === "idle") {
      void performInitialLoad();
    }
  }, [encryptionKeys, pubkeyHex, performInitialLoad]);

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
