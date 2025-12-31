import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deriveNostrKeysFromPin } from "@/lib/pin-crypto";
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

const MIN_PIN_LENGTH = 8;
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

function validatePin(pin: string): string | null {
  if (pin.length < MIN_PIN_LENGTH) {
    return `PIN must be at least ${MIN_PIN_LENGTH} characters`;
  }
  if (!/\d/.test(pin)) {
    return "PIN must contain at least one number";
  }
  if (!/[a-zA-Z]/.test(pin)) {
    return "PIN must contain at least one letter";
  }
  return null;
}

export function NostrSyncPanel({ history, onHistoryLoaded }: NostrSyncPanelProps) {
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleSave = async () => {
    const error = validatePin(pin);
    if (error) {
      setStatus("error");
      setMessage(error);
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
    const error = validatePin(pin);
    if (error) {
      setStatus("error");
      setMessage(error);
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
      <div className="text-xs text-muted-foreground">
        Use a password manager to generate and store your PIN.
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          placeholder="PIN (8+ chars, letters & numbers)"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="flex-1 h-7 text-xs"
          disabled={isLoading}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleSave}
          disabled={isLoading}
          className="h-7 text-xs"
        >
          {status === "saving" ? "..." : "Save"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleLoad}
          disabled={isLoading}
          className="h-7 text-xs"
        >
          {status === "loading" ? "..." : "Load"}
        </Button>
      </div>
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
