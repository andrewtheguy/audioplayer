import { useCallback, useEffect, useRef, useState } from "react";
import { deriveNostrKeys } from "@/lib/nostr-crypto";
import {
  loadHistoryFromNostr,
  mergeHistory,
  saveHistoryToNostr,
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
  performLoad: (currentSecret: string, isTakeOver?: boolean) => Promise<void>;
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
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const sessionStatusRef = useRef(sessionStatus);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextDirtyRef = useRef(false);
  const hasMountedRef = useRef(false);

  useEffect(() => {
    historyRef.current = history;
    onHistoryLoadedRef.current = onHistoryLoaded;
    onTakeOverRef.current = onTakeOver;
  }, [history, onHistoryLoaded, onTakeOver]);

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
      if (!currentSecret) return false;

      const shouldBlockSave = () =>
        sessionStatusRef.current === "stale" && !options?.allowStale;

      if (shouldBlockSave()) {
        console.warn("Attempted to save while stale. Ignoring.");
        return false;
      }

      try {
        const keys = await withTimeout(
          deriveNostrKeys(currentSecret),
          operationTimeoutMs
        );
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
            localSessionId
          ),
          operationTimeoutMs
        );
        const fingerprint = await getSecretFingerprint(currentSecret);
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
        setStatus("error");
        if (err instanceof TimeoutError) {
          setMessage("Save timed out. Check connection.");
        } else {
          setMessage(err instanceof Error ? err.message : "Failed to save");
        }
        return false;
      }
    },
    [localSessionId, operationTimeoutMs]
  );

  const performLoad = useCallback(
    async (currentSecret: string, isTakeOver = false) => {
      if (!currentSecret) return;

      setStatus("loading");
      setMessage("Syncing...");
      if (isTakeOver) {
        startTakeoverGrace();
      }

      try {
        const keys = await withTimeout(
          deriveNostrKeys(currentSecret),
          operationTimeoutMs
        );
        const cloudData = await withTimeout(
          loadHistoryFromNostr(keys.privateKey, keys.publicKey),
          operationTimeoutMs
        );

        const fingerprint = await getSecretFingerprint(currentSecret);
        setLastOperation({
          type: "loaded",
          fingerprint,
          timestamp: formatTimestamp(new Date()),
        });

        if (cloudData) {
          const { history: cloudHistory, sessionId: remoteSid } = cloudData;

          const isStaleRemote =
            !isTakeOver && remoteSid && remoteSid !== localSessionId;
          if (isStaleRemote) {
            setSessionStatus("stale");
            setStatus("success");
            setSessionNotice(
              "Another session is active — viewing in read-only mode. Take over to edit."
            );
          }

          const result = mergeHistory(historyRef.current, cloudHistory, {
            preferRemote: isTakeOver,
            preferRemoteOrder: isTakeOver,
          });
          skipNextDirtyRef.current = true;
          onHistoryLoadedRef.current(result.merged);
          if (isTakeOver) {
            onTakeOverRef.current?.(cloudHistory);
          }

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
        } else {
          setStatus("success");
          setSessionStatus("active");
          clearSessionNotice();
          setMessage("Session started (new)");
          dirtyRef.current = false;
          void performSave(currentSecret, historyRef.current, { allowStale: true });
        }
      } catch (err) {
        setStatus("error");
        if (err instanceof TimeoutError) {
          setMessage("Load timed out. Check your connection and try again.");
        } else {
          setMessage(err instanceof Error ? err.message : "Failed to load");
        }
      }
    },
    [
      clearSessionNotice,
      localSessionId,
      operationTimeoutMs,
      performSave,
      setSessionNotice,
      setSessionStatus,
      startTakeoverGrace,
    ]
  );

  useEffect(() => {
    if (!secret) return;
    const timeoutId = setTimeout(() => {
      void performLoad(secret);
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [performLoad, secret]);

  useEffect(() => {
    if (!secret || sessionStatus !== "active" || !dirtyRef.current) return;

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(() => {
      void performSave(secret, history).then((didSave) => {
        if (didSave) dirtyRef.current = false;
      });
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
