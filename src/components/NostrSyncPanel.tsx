import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deriveNostrKeysFromPin, generatePin } from "@/lib/pin-crypto";
import {
  saveHistoryToNostr,
  loadHistoryFromNostr,
  mergeHistory,
} from "@/lib/nostr-sync";
import type { HistoryEntry } from "@/lib/history";

interface NostrSyncPanelProps {
  history: HistoryEntry[];
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
}

type SyncStatus = "idle" | "saving" | "loading" | "success" | "error";
type ViewState = "input" | "generated" | "copied";

const OPERATION_TIMEOUT_MS = 30000; // 30 seconds

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

export function NostrSyncPanel({ history, onHistoryLoaded }: NostrSyncPanelProps) {
  const [pin, setPin] = useState("");
  const [generatedPin, setGeneratedPin] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState>("input");
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleGenerate = () => {
    const newPin = generatePin();
    setGeneratedPin(newPin);
    setViewState("generated");
    setMessage(null);
    setStatus("idle");
  };

  const handleCopy = async () => {
    if (!generatedPin) return;

    try {
      await navigator.clipboard.writeText(generatedPin);
      setGeneratedPin(null);
      setViewState("copied");
      setMessage("PIN copied! Paste it below to sync.");
      setStatus("success");
    } catch {
      setMessage("Failed to copy to clipboard");
      setStatus("error");
    }
  };

  const handleSave = async () => {
    if (!pin) {
      setStatus("error");
      setMessage("Please enter your PIN");
      return;
    }

    setStatus("saving");
    setMessage(null);

    try {
      const keys = await withTimeout(
        deriveNostrKeysFromPin(pin),
        OPERATION_TIMEOUT_MS
      );
      await withTimeout(
        saveHistoryToNostr(history, keys.privateKey, keys.publicKey),
        OPERATION_TIMEOUT_MS
      );
      setStatus("success");
      setMessage(`Saved ${history.length} entries`);
    } catch (err) {
      setStatus("error");
      if (err instanceof TimeoutError) {
        setMessage("Save timed out. Check your connection and try again.");
      } else {
        setMessage(err instanceof Error ? err.message : "Failed to save");
      }
    }
  };

  const handleLoad = async () => {
    if (!pin) {
      setStatus("error");
      setMessage("Please enter your PIN");
      return;
    }

    setStatus("loading");
    setMessage(null);

    try {
      const keys = await withTimeout(
        deriveNostrKeysFromPin(pin),
        OPERATION_TIMEOUT_MS
      );
      const cloudHistory = await withTimeout(
        loadHistoryFromNostr(keys.privateKey, keys.publicKey),
        OPERATION_TIMEOUT_MS
      );

      if (cloudHistory) {
        const result = mergeHistory(history, cloudHistory);
        onHistoryLoaded(result.merged);
        setStatus("success");
        setMessage(
          result.addedFromCloud > 0
            ? `Added ${result.addedFromCloud} entries from cloud`
            : "History is up to date"
        );
      } else {
        setStatus("success");
        setMessage("No history found on Nostr");
      }
    } catch (err) {
      setStatus("error");
      if (err instanceof TimeoutError) {
        setMessage("Load timed out. Check your connection and try again.");
      } else {
        setMessage(err instanceof Error ? err.message : "Failed to load");
      }
    }
  };

  const isLoading = status === "saving" || status === "loading";

  return (
    <div className="border-t pt-3 mt-3 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Nostr Sync
      </div>

      {/* Generated PIN display */}
      {viewState === "generated" && generatedPin && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 p-2 bg-muted rounded-md">
            <code className="flex-1 text-xs font-mono select-all">
              {generatedPin}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopy}
              className="h-6 text-xs"
            >
              Copy
            </Button>
          </div>
          <div className="text-xs text-amber-600 dark:text-amber-500">
            Save this PIN in your password manager. It cannot be recovered.
          </div>
        </div>
      )}

      {/* Input state or after copy */}
      {(viewState === "input" || viewState === "copied") && (
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={handleGenerate}
            disabled={isLoading}
            className="h-7 text-xs"
          >
            Generate New PIN
          </Button>

          <div className="text-xs text-muted-foreground">
            Or paste existing PIN:
          </div>

          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder="Paste your PIN"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                if (viewState === "copied") {
                  setViewState("input");
                  setMessage(null);
                }
              }}
              className="flex-1 h-7 text-xs font-mono"
              disabled={isLoading}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleSave}
              disabled={isLoading || !pin}
              className="h-7 text-xs"
            >
              {status === "saving" ? "..." : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleLoad}
              disabled={isLoading || !pin}
              className="h-7 text-xs"
            >
              {status === "loading" ? "..." : "Load"}
            </Button>
          </div>
        </>
      )}

      {message && (
        <div
          className={`text-xs ${
            status === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {message}
        </div>
      )}
    </div>
  );
}
