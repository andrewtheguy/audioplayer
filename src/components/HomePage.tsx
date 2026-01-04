import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { generateSecret, isValidSecret } from "@/lib/nostr-crypto";
import {
  getLastUsedSecret,
  getStorageFingerprint,
  getHistory,
  saveHistory,
} from "@/lib/history";

export function HomePage() {
  const [customId, setCustomId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedSecret] = useState(() => getLastUsedSecret());
  const [forkHistory, setForkHistory] = useState(false);

  const handleGenerateNew = async () => {
    const newSecret = generateSecret();

    if (forkHistory && savedSecret) {
      const oldFingerprint = await getStorageFingerprint(savedSecret);
      const oldHistory = getHistory(oldFingerprint);
      if (oldHistory.length > 0) {
        const newFingerprint = await getStorageFingerprint(newSecret);
        saveHistory(oldHistory, newFingerprint);
      }
    }

    window.location.hash = newSecret;
  };

  const handleJoinSession = () => {
    const trimmed = customId.trim();
    if (!trimmed) {
      setError("Please enter a session ID");
      return;
    }
    if (!isValidSecret(trimmed)) {
      setError("Invalid session ID. Check for typos.");
      return;
    }
    setError(null);
    window.location.hash = trimmed;
  };

  const handleResumePrevious = () => {
    if (savedSecret) {
      window.location.hash = savedSecret;
    }
  };

  return (
    <div className="w-full max-w-md mx-auto space-y-6">
      <div className="text-center space-y-2">
        <p className="text-muted-foreground">
          Start a new session or enter an existing session ID to sync your audio
          playback across devices.
        </p>
      </div>

      <div className="space-y-2">
        <Button onClick={handleGenerateNew} className="w-full">
          Start New Session
        </Button>
        {savedSecret && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={forkHistory}
              onChange={(e) => setForkHistory(e.target.checked)}
              className="rounded"
            />
            Copy history from previous session
          </label>
        )}
      </div>

      {savedSecret && (
        <Button
          variant="outline"
          onClick={handleResumePrevious}
          className="w-full"
        >
          Resume Previous Session
        </Button>
      )}

      <div className="space-y-3 pt-4 border-t">
        <label className="text-sm font-medium">Or enter a session ID</label>
        <div className="flex gap-2">
          <Input
            type="text"
            value={customId}
            onChange={(e) => {
              setCustomId(e.target.value);
              setError(null);
            }}
            placeholder="Paste session ID here"
            onKeyDown={(e) => e.key === "Enter" && handleJoinSession()}
          />
          <Button variant="secondary" onClick={handleJoinSession}>
            Join
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}
