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

export function NostrSyncPanel({ history, onHistoryLoaded }: NostrSyncPanelProps) {
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleSave = async () => {
    if (pin.length < 4) {
      setStatus("error");
      setMessage("PIN must be at least 4 digits");
      return;
    }

    setStatus("saving");
    setMessage(null);

    try {
      const keys = await deriveNostrKeysFromPin(pin);
      await saveHistoryToNostr(history, keys.privateKey, keys.publicKey);
      setStatus("success");
      setMessage(`Saved ${history.length} entries`);
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const handleLoad = async () => {
    if (pin.length < 4) {
      setStatus("error");
      setMessage("PIN must be at least 4 digits");
      return;
    }

    setStatus("loading");
    setMessage(null);

    try {
      const keys = await deriveNostrKeysFromPin(pin);
      const cloudHistory = await loadHistoryFromNostr(
        keys.privateKey,
        keys.publicKey
      );

      if (cloudHistory) {
        const merged = mergeHistory(history, cloudHistory);
        const added = merged.length - history.length;
        onHistoryLoaded(merged);
        setStatus("success");
        setMessage(
          added > 0
            ? `Added ${added} entries from cloud`
            : "History is up to date"
        );
      } else {
        setStatus("success");
        setMessage("No history found on Nostr");
      }
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Failed to load");
    }
  };

  const isLoading = status === "saving" || status === "loading";

  return (
    <div className="border-t pt-3 mt-3 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">
        Nostr Sync
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="PIN (4+ digits)"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          className="w-28 h-7 text-xs"
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
