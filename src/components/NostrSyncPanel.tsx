import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { deriveNostrKeys, generateSecret } from "@/lib/pin-crypto";
import {
  saveHistoryToNostr,
  loadHistoryFromNostr,
  mergeHistory,
  subscribeToHistory,
  RELAYS,
} from "@/lib/nostr-sync";
import type { HistoryEntry } from "@/lib/history";
import { cn } from "@/lib/utils";

interface NostrSyncPanelProps {
  history: HistoryEntry[];
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onSessionStatusChange?: (status: SessionStatus) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
}

type SyncStatus = "idle" | "saving" | "loading" | "success" | "error";
type SessionStatus = "unclaimed" | "active" | "stale" | "unknown";

interface LastOperation {
  type: "saved" | "loaded";
  fingerprint: string;
  timestamp: string;
}

/**
 * Generate a fingerprint from secret using SHA256 hash prefix.
 * Returns first 8 hex characters formatted as xxxx-xxxx.
 */
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

/**
 * Format timestamp for display with date and time
 */
function formatTimestamp(date: Date): string {
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const OPERATION_TIMEOUT_MS = 30000; // 30 seconds
const DEBOUNCE_SAVE_MS = 5000; // 5 seconds auto-save debounce

class TimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Wrap a promise with a timeout. Rejects with TimeoutError if not resolved in time.
 */
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

/**
 * Get the secret directly from the URL hash.
 * Removes the '#' prefix if present.
 */
function getSecretFromHash(): string {
  if (typeof window === "undefined") return "";
  const hash = window.location.hash;
  return hash.startsWith("#") ? hash.slice(1) : hash;
}

export function NostrSyncPanel({
  history,
  onHistoryLoaded,
  onSessionStatusChange,
  onTakeOver,
}: NostrSyncPanelProps) {
  const [secret, setSecret] = useState(getSecretFromHash());
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [lastOperation, setLastOperation] = useState<LastOperation | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // Session Management
  const [localSessionId] = useState(() => crypto.randomUUID());
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("unknown");
  // const [remoteSessionId, setRemoteSessionId] = useState<string | null>(null);

  // Keep refs for props to ensure performLoad is stable and doesn't trigger effect loops
  const historyRef = useRef(history);
  const onHistoryLoadedRef = useRef(onHistoryLoaded);
  const onTakeOverRef = useRef(onTakeOver);
  const sessionStatusRef = useRef(sessionStatus);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    historyRef.current = history;
    onHistoryLoadedRef.current = onHistoryLoaded;
    onTakeOverRef.current = onTakeOver;
  }, [history, onHistoryLoaded, onTakeOver]);

  useEffect(() => {
    sessionStatusRef.current = sessionStatus;
    onSessionStatusChange?.(sessionStatus);
  }, [sessionStatus, onSessionStatusChange]);

  const performSave = useCallback(async (
      currentSecret: string,
      historyToSave: HistoryEntry[],
      options?: { allowStale?: boolean }
    ) => {
      if (!currentSecret) return;
      
      // Don't save if we are stale!
      if (sessionStatusRef.current === 'stale' && !options?.allowStale) {
          console.warn("Attempted to save while stale. Ignoring.");
          return;
      }

      setStatus("saving");
      // Only show "Saving..." if manual? For auto-save maybe subtle?
      // For now let's show it.
      
      try {
        const keys = await withTimeout(
          deriveNostrKeys(currentSecret),
          OPERATION_TIMEOUT_MS
        );
        await withTimeout(
          saveHistoryToNostr(historyToSave, keys.privateKey, keys.publicKey, localSessionId),
          OPERATION_TIMEOUT_MS
        );
        const fingerprint = await getSecretFingerprint(currentSecret);
        setLastOperation({
          type: "saved",
          fingerprint,
          timestamp: formatTimestamp(new Date()),
        });
        setStatus("success");
        setMessage(`Saved ${historyToSave.length} entries`);
      } catch (err) {
        setStatus("error");
        if (err instanceof TimeoutError) {
          setMessage("Save timed out. Check connection.");
        } else {
          setMessage(err instanceof Error ? err.message : "Failed to save");
        }
      }
  }, [localSessionId]);

  // Load logic extracted to be reusable
  const performLoad = useCallback(async (currentSecret: string, isTakeOver = false) => {
    if (!currentSecret) return;

    setStatus("loading");
    setMessage("Syncing...");

    try {
      const keys = await withTimeout(
        deriveNostrKeys(currentSecret),
        OPERATION_TIMEOUT_MS
      );
      const cloudData = await withTimeout(
        loadHistoryFromNostr(keys.privateKey, keys.publicKey),
        OPERATION_TIMEOUT_MS
      );

      const fingerprint = await getSecretFingerprint(currentSecret);
      setLastOperation({
        type: "loaded",
        fingerprint,
        timestamp: formatTimestamp(new Date()),
      });

      if (cloudData) {
        const { history: cloudHistory, sessionId: remoteSid } = cloudData;
        
        // If we are just checking (initial load), logic is different from "Take Over"
        if (!isTakeOver) {
             // If remote session exists and is not us
             if (remoteSid && remoteSid !== localSessionId) {
                 setSessionStatus("stale");
                 setStatus("success");
                 setMessage("Another session is active. Take over?");
                 return; // Do NOT merge yet
             }
        }

        // Use refs to get latest values
        const result = mergeHistory(historyRef.current, cloudHistory, {
          preferRemote: isTakeOver,
          preferRemoteOrder: isTakeOver,
        });
        onHistoryLoadedRef.current(result.merged);
        if (isTakeOver) {
          onTakeOverRef.current?.(cloudHistory);
        }
        
        setStatus("success");
        setMessage(
          result.addedFromCloud > 0
            ? `Added ${result.addedFromCloud} entries from cloud`
            : "History is up to date"
        );
        
        // If taking over or new/matching session, become active
        if (isTakeOver || !remoteSid || remoteSid === localSessionId) {
             setSessionStatus("active");
             // Force save to claim session if taking over or if new
             if (isTakeOver || !remoteSid) {
                  // Wait a tick for merge to settle? No, we have merged result.
                  // Save merged history immediately to claim session
                  performSave(currentSecret, result.merged, { allowStale: isTakeOver });
             }
        }

      } else {
        // No history found -> we claim it
        setStatus("success");
        setSessionStatus("active");
        setMessage("Session started (new)");
        // Save initial empty/current state to claim
        performSave(currentSecret, historyRef.current, { allowStale: true });
      }
    } catch (err) {
      setStatus("error");
      if (err instanceof TimeoutError) {
        setMessage("Load timed out. Check your connection and try again.");
      } else {
        setMessage(err instanceof Error ? err.message : "Failed to load");
      }
    }
  }, [localSessionId, performSave]); // Stable dependency

  // Subscription for "Stale" detection
  useEffect(() => {
    if (!secret) return;
    
    let cleanup: (() => void) | undefined;

    const setupSubscription = async () => {
        const keys = await deriveNostrKeys(secret);
        cleanup = subscribeToHistory(keys.publicKey, (remoteSid) => {
            // If we see a session ID that is NOT ours, we are stale.
            if (remoteSid && remoteSid !== localSessionId) {
                setSessionStatus((prev) => {
                    if (prev !== 'stale') {
                         setMessage("Session taken over by another device.");
                         return 'stale';
                    }
                    return prev;
                });
            } else if (remoteSid === localSessionId) {
                 // Confirmed active
                 setSessionStatus('active');
            }
        });
    };
    
    setupSubscription();
    
    return () => {
        if (cleanup) cleanup();
    };
  }, [secret, localSessionId]);

  // Sync state with URL hash and auto-load on change
  useEffect(() => {
    const handleHashChange = () => {
      const newSecret = getSecretFromHash();
      setSecret(newSecret);
      if (newSecret) {
        performLoad(newSecret);
      } else {
        // Reset state if hash is cleared
        setStatus("idle");
        setMessage(null);
        setLastOperation(null);
        setSessionStatus("unknown");
      }
    };

    window.addEventListener("hashchange", handleHashChange);

    // Initial check on mount
    const initialSecret = getSecretFromHash();
    if (initialSecret) {
      // Use setTimeout to avoid "setState in effect" warning and ensure async execution
      setTimeout(() => {
        performLoad(initialSecret);
      }, 0);
    }

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, [performLoad]); // performLoad now handles initial load logic

  // Auto-Save Effect
  useEffect(() => {
      if (!secret || sessionStatus !== 'active') return;
      
      // If history changes, debounce save
      if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
      }
      
      // Only auto-save if we have changes? 
      // Actually we just save whatever is current state periodically if it changes.
      // But we need to avoid saving on *load*. 
      // This effect runs when `history` changes.
      // `history` changes when we load from cloud too.
      // So we might auto-save immediately after load?
      // `performLoad` does a save if it merges/claims.
      
      autoSaveTimerRef.current = setTimeout(() => {
          performSave(secret, history);
      }, DEBOUNCE_SAVE_MS);
      
      return () => {
          if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      };
  }, [history, secret, sessionStatus, performSave]);


  const handleGenerate = () => {
    const newSecret = generateSecret();
    window.location.hash = newSecret;
    // The hashchange listener will pick this up and trigger state update + load
  };

  const handleCopyLink = async () => {
    if (!secret) return;
    const url = window.location.href;

    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);

      // If we are in success state, keep the message, otherwise show temporary copy feedback
      if (status !== 'success') {
          setMessage("Link copied to clipboard!");
          // Reset message after delay if it was just the copy confirmation
          setTimeout(() => {
              // We need to check the current status via a ref or functional update if we were inside the effect,
              // but here we just want to clear if it hasn't changed to something important.
              // However, since we can't easily check 'current' status inside timeout without refs,
              // we'll just clear if the message is still the copy message.
              setMessage((prev) => prev === "Link copied to clipboard!" ? null : prev);
          }, 3000);
      }
    } catch {
      setMessage("Failed to copy link");
      setStatus("error");
    }
  };

  const handleTakeOver = () => {
      if (!secret) return;
      performLoad(secret, true); // true = force take over
  };

  const isLoading = status === "saving" || status === "loading";

  return (
    <div className="border-t pt-3 mt-3 space-y-2">
      <div className="text-xs font-medium text-muted-foreground flex justify-between items-center">
        <span>Nostr Sync</span>
        {secret && (
             <div className="flex items-center gap-2">
                 {sessionStatus === 'active' && <span className="text-[10px] text-green-500 font-bold px-1.5 py-0.5 bg-green-500/10 rounded-full">ACTIVE</span>}
                 {sessionStatus === 'stale' && <span className="text-[10px] text-amber-500 font-bold px-1.5 py-0.5 bg-amber-500/10 rounded-full">READ-ONLY</span>}
                 <span className="font-mono text-[10px] opacity-70" title="Your secret key is in the URL">
                     Connected
                 </span>
             </div>
        )}
      </div>

      {!secret ? (
        <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
                Generate a secret link to sync your history across devices.
            </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleGenerate}
            disabled={isLoading}
            className="w-full h-8 text-xs"
          >
            Generate Secret Link
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {sessionStatus === 'stale' ? (
              <Button 
                size="sm"
                variant="default" // Emphasize
                onClick={handleTakeOver}
                disabled={isLoading}
                className="w-full h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white"
              >
                  Take Over Session
              </Button>
          ) : (
              // Auto-save is active, so we don't strictly need a Save button, 
              // but keeping it for manual force-save or feedback is nice.
              // Maybe change text to "Saved" or just remove it?
              // Let's keep it as "Force Save" or "Sync Now" if active.
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => performSave(secret, history)}
                  disabled={isLoading}
                  className="flex-1 h-8 text-xs bg-primary/5 hover:bg-primary/10 border-primary/20"
                >
                  {status === "saving" ? "Saving..." : "Sync Now"}
                </Button>
                
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCopyLink}
                  className="h-8 text-xs px-3"
                  title="Copy link to share or save"
                >
                   {copiedLink ? <CheckIcon className="w-3.5 h-3.5 mr-1" /> : <LinkIcon className="w-3.5 h-3.5 mr-1" />}
                   {copiedLink ? "Copied" : "Copy Link"}
                </Button>
              </div>
          )}
          
           <div className="text-[10px] text-muted-foreground text-center px-1">
             {sessionStatus === 'active' ? 'Auto-save enabled.' : 'Bookmark this URL to access your history.'}
           </div>
        </div>
      )}

      {message && (
        <div
          className={cn("text-xs p-2 rounded-md bg-muted/50 transition-colors", 
            status === "error" && "text-destructive bg-destructive/5 border border-destructive/10",
            status !== "error" && "text-muted-foreground",
            sessionStatus === 'stale' && "bg-amber-500/10 text-amber-600 border border-amber-500/20"
          )}
        >
          {message}
          {status === "success" && lastOperation && lastOperation.type !== 'loaded' && sessionStatus !== 'stale' && (
            <span className="block mt-1 opacity-75 text-[10px]">
              {lastOperation.type === "saved" ? "Saved" : "Loaded"} at {lastOperation.timestamp}
            </span>
          )}
        </div>
      )}

      {/* Collapsible details panel */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => setShowDetails(!showDetails)}
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <span className="inline-block w-3 text-center">
            {showDetails ? "▼" : "▶"}
          </span>
          Details
        </button>
        {showDetails && (
          <div className="mt-2 pl-4 text-xs text-muted-foreground space-y-1">
            <div className="font-medium">Relays:</div>
            <ul className="list-disc pl-4 space-y-0.5">
              {RELAYS.map((relay) => (
                <li key={relay} className="font-mono text-[10px]">
                  {relay}
                </li>
              ))}
            </ul>
             {secret && (
                <div className="pt-2">
                    <div className="font-medium">Secret Fingerprint:</div>
                    <code className="font-mono text-[10px] block mt-0.5 select-all">
                        {lastOperation?.fingerprint || "..."}
                    </code>
                     <div className="font-medium mt-1">Session ID:</div>
                    <code className="font-mono text-[10px] block mt-0.5 select-all truncate">
                        {localSessionId}
                    </code>
                </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LinkIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
