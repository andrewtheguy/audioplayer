import { useCallback, useEffect, useRef, useState } from "react";
import { deriveNostrKeys } from "@/lib/nostr-crypto";
import {
  loadHistoryFromNostr,
  mergeHistory,
  saveHistoryToNostr,
  subscribeToHistoryDetailed,
} from "@/lib/nostr-sync";
import type { HistoryEntry } from "@/lib/history";
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
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
  debounceSaveMs?: number;
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
}

const DEFAULT_DEBOUNCE_SAVE_MS = 5000;
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
  onHistoryLoaded,
  onTakeOver,
  onRemoteSync,
  debounceSaveMs = DEFAULT_DEBOUNCE_SAVE_MS,
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
  const followRemoteInFlightRef = useRef(false);
  const lastRemoteCreatedAtRef = useRef(0);
  const performLoadRef = useRef<
    ((
      currentSecret: string,
      isTakeOver?: boolean,
      options?: { followRemote?: boolean; silent?: boolean }
    ) => Promise<void>) | null
  >(null);

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
  });

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
  }, [sessionStatus]);

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
      options?: { allowStale?: boolean }
    ) => {
      if (!currentSecret || !isActive()) return false;
      const signal = abortRef.current?.signal;
      if (signal?.aborted) return false;

      const shouldBlockSave = () =>
        sessionStatusRef.current === "stale" && !options?.allowStale;

      if (shouldBlockSave()) {
        console.warn("Attempted to save while stale. Ignoring.");
        return false;
      }

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
        setStatus("saving");
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
        const fingerprint = await getSecretFingerprint(currentSecret);
        if (!isActive()) return false;
        setLastOperation({
          type: "saved",
          fingerprint,
          timestamp: formatTimestamp(new Date()),
        });
        setStatus("success");
        setMessage(`Saved ${historyToSave.length} entries`);
        dirtyRef.current = false;
        return true;
      } catch (err) {
        if (!isActive()) return false;
        setStatus("error");
        if (err instanceof TimeoutError) {
          setMessage("Save timed out. Check connection.");
        } else {
          setMessage(err instanceof Error ? err.message : "Failed to save");
        }
        return false;
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
      if (isTakeOver) {
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
          const { history: cloudHistory, sessionId: remoteSid, createdAt } = cloudData;
          if (createdAt > lastRemoteCreatedAtRef.current) {
            lastRemoteCreatedAtRef.current = createdAt;
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

  useEffect(() => {
    if (!secret) return;
    void performLoadRef.current?.(secret);
  }, [secret]);

  useEffect(() => {
    if (!secret || sessionStatus !== "stale") return;
    let cancelled = false;

    const setupSubscription = async () => {
      const keys = await deriveNostrKeys(secret);
      if (cancelled) return null;
      const cleanup = subscribeToHistoryDetailed(
        keys.publicKey,
        keys.privateKey,
        (data) => {
          if (cancelled) return;
          if (data.sessionId && data.sessionId === localSessionId) return;
          if (data.createdAt <= lastRemoteCreatedAtRef.current) return;
          lastRemoteCreatedAtRef.current = data.createdAt;
          mergeAndNotify(data.history, false, true);
        }
      );
      return cleanup;
    };

    const cleanupPromise = setupSubscription().catch((err) => {
      if (!cancelled) {
        console.error("Failed to setup slave sync subscription:", err);
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
  }, [secret, sessionStatus, mergeAndNotify, localSessionId]);

  useEffect(() => {
    if (!secret || sessionStatus !== "stale") return;
    let cancelled = false;
    const intervalId = window.setInterval(() => {
      if (cancelled) return;
      if (followRemoteInFlightRef.current) return;
      followRemoteInFlightRef.current = true;
      void performLoadRef
        .current?.(secret, false, { followRemote: true, silent: true })
        .finally(() => {
          followRemoteInFlightRef.current = false;
        });
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [secret, sessionStatus]);

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

  return {
    status: secret ? status : "idle",
    message: secret ? message : null,
    lastOperation: secret ? lastOperation : null,
    setMessage,
    performSave,
    performLoad,
  };
}

export type { SyncStatus, LastOperation };
