import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { generateSecret, isValidSecret } from "@/lib/nostr-crypto";
import {
  getLastUsedSecret,
  getStorageFingerprint,
  getHistory,
  saveHistory,
} from "@/lib/history";

function formatFingerprint(fingerprint: string): string {
  return fingerprint.toUpperCase().match(/.{1,4}/g)?.join("-") ?? fingerprint;
}

export function HomePage() {
  const [customId, setCustomId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedSecret] = useState(() => getLastUsedSecret());
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(null);
  const [savedHistoryCount, setSavedHistoryCount] = useState(0);
  const [forkHistory, setForkHistory] = useState(false);
  const [showJoinSection, setShowJoinSection] = useState(false);

  useEffect(() => {
    if (!savedSecret) return;
    let cancelled = false;
    getStorageFingerprint(savedSecret).then((fp) => {
      if (cancelled) return;
      setSavedFingerprint(fp);
      const history = getHistory(fp);
      setSavedHistoryCount(history.length);
    });
    return () => {
      cancelled = true;
    };
  }, [savedSecret]);

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
      setError("Please enter a player ID");
      return;
    }
    if (!isValidSecret(trimmed)) {
      setError("Invalid player ID. Check for typos.");
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
      {/* Previous Session Card */}
      {savedSecret && savedFingerprint && (
        <div className="border rounded-lg p-4 space-y-4 bg-muted/30">
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground">
              Previous Session
            </div>
            <div className="font-mono text-sm tracking-wide">
              {formatFingerprint(savedFingerprint)}
            </div>
            <div className="text-xs text-muted-foreground">
              {savedHistoryCount} item{savedHistoryCount !== 1 ? "s" : ""} in
              history
            </div>
          </div>
          <Button onClick={handleResumePrevious} className="w-full">
            Resume Session
          </Button>
        </div>
      )}

      {/* New Session Section */}
      <div className="space-y-3">
        {savedSecret && (
          <div className="text-xs font-medium text-muted-foreground">
            Or start fresh
          </div>
        )}
        <Button
          variant={savedSecret ? "outline" : "default"}
          onClick={handleGenerateNew}
          className="w-full"
        >
          Start New Session
        </Button>
        {savedSecret && savedHistoryCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer pl-1">
            <input
              type="checkbox"
              checked={forkHistory}
              onChange={(e) => setForkHistory(e.target.checked)}
              className="rounded"
            />
            Copy history to new session
          </label>
        )}
      </div>

      {/* Join Existing Session */}
      <div className="pt-2">
        <button
          type="button"
          onClick={() => setShowJoinSection(!showJoinSection)}
          className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          <span className="inline-block w-4 text-center">
            {showJoinSection ? "▼" : "▶"}
          </span>
          Join existing player
        </button>
        {showJoinSection && (
          <div className="mt-3 space-y-3 pl-5">
            <div className="flex gap-2">
              <Input
                type="text"
                value={customId}
                onChange={(e) => {
                  setCustomId(e.target.value);
                  setError(null);
                }}
                placeholder="Paste player ID"
                onKeyDown={(e) => e.key === "Enter" && handleJoinSession()}
              />
              <Button variant="secondary" onClick={handleJoinSession}>
                Join
              </Button>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}
      </div>

      {/* Help text */}
      <p className="text-xs text-muted-foreground text-center pt-2">
        Sessions sync your audio playback across devices via Nostr.
      </p>
    </div>
  );
}
