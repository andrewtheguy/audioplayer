import { useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { getPublicKey } from "nostr-tools/pure";
import {
  decodeNsec,
  deriveEncryptionKey,
  encodeNpub,
  generatePlayerId,
  generateSecondarySecret,
} from "@/lib/nostr-crypto";
import { clearSecondarySecret, getStorageScope } from "@/lib/identity";
import { clearHistory } from "@/lib/history";
import {
  loadHistoryFromNostr,
  loadPlayerIdFromNostr,
  publishPlayerIdToNostr,
  saveHistoryToNostr,
} from "@/lib/nostr-sync";

export function SettingsPage() {
  const navigate = useNavigate();

  const [nsecInput, setNsecInput] = useState("");
  const [currentSecretInput, setCurrentSecretInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [newSecondarySecret, setNewSecondarySecret] = useState<string | null>(null);
  const [derivedNpub, setDerivedNpub] = useState<string | null>(null);
  const [skipHistoryMigration, setSkipHistoryMigration] = useState(false);

  // Derive npub from nsec as user types
  const handleNsecChange = (value: string) => {
    setNsecInput(value);
    const trimmed = value.trim();
    if (!trimmed) {
      setDerivedNpub(null);
      return;
    }
    try {
      const privateKeyBytes = decodeNsec(trimmed);
      if (privateKeyBytes) {
        const pubkeyHex = getPublicKey(privateKeyBytes);
        setDerivedNpub(encodeNpub(pubkeyHex));
      } else {
        setDerivedNpub(null);
      }
    } catch {
      setDerivedNpub(null);
    }
  };

  const handleBackToHome = () => {
    navigate("/");
  };

  const handleRotatePlayerId = async () => {
    setMessage(null);
    setNewSecondarySecret(null);

    // Validate and decode nsec
    const trimmedNsec = nsecInput.trim();
    let privateKeyBytes: Uint8Array | null;
    try {
      privateKeyBytes = decodeNsec(trimmedNsec);
    } catch {
      setMessage("Invalid nsec format.");
      return;
    }
    if (!privateKeyBytes) {
      setMessage("Invalid nsec format.");
      return;
    }

    // Derive pubkey from nsec
    const pubkeyHex = getPublicKey(privateKeyBytes);
    const npub = encodeNpub(pubkeyHex);

    setStatus("loading");

    // Try to migrate history if not skipped
    let historyToMigrate: import("@/lib/history").HistoryEntry[] | null = null;
    if (!skipHistoryMigration) {
      const trimmedSecret = currentSecretInput.trim();
      if (!trimmedSecret) {
        setMessage("Current secondary secret is required for history migration.");
        setStatus("error");
        return;
      }

      try {
        // Load old player ID using the provided secret
        const oldPlayerId = await loadPlayerIdFromNostr(pubkeyHex, trimmedSecret);

        if (oldPlayerId) {
          // Derive old encryption keys and load history
          const oldKeys = await deriveEncryptionKey(oldPlayerId);
          const historyPayload = await loadHistoryFromNostr(oldKeys);

          if (historyPayload) {
            historyToMigrate = historyPayload.history;
          }
        } else {
          setMessage("Could not load player ID with the provided secret.");
          setStatus("error");
          return;
        }
      } catch (err) {
        console.warn("Failed to load history for migration:", err);
        setMessage("Failed to load history with the provided secret.");
        setStatus("error");
        return;
      }
    }

    // Generate new secondary secret and player ID
    const newSecret = generateSecondarySecret();
    const newPlayerId = generatePlayerId();

    // Publish to relay
    try {
      await publishPlayerIdToNostr(
        newPlayerId,
        newSecret,
        privateKeyBytes,
        pubkeyHex
      );
    } catch (err) {
      setMessage(`Failed to publish: ${err instanceof Error ? err.message : "Unknown error"}`);
      setStatus("error");
      return;
    }

    // Migrate history to new player ID if we have history to migrate
    let historyMigrationFailed = false;
    if (historyToMigrate && historyToMigrate.length > 0) {
      try {
        const newKeys = await deriveEncryptionKey(newPlayerId);
        await saveHistoryToNostr(historyToMigrate, newKeys);
      } catch (err) {
        console.error("Failed to migrate history:", err);
        historyMigrationFailed = true;
      }
    }

    // Clear the old secondary secret and local history from this device
    // Note: New credentials are already published - rotation is complete regardless of local cleanup
    let cleanupFailed = false;
    try {
      const fingerprint = await getStorageScope(pubkeyHex);
      if (fingerprint) {
        try {
          clearSecondarySecret(fingerprint);
          clearHistory(fingerprint);
        } catch (clearErr) {
          console.error("Failed to clear old data:", clearErr);
          cleanupFailed = true;
        }
      }
    } catch (err) {
      console.error("Failed to get storage scope:", err);
      cleanupFailed = true;
    }

    setStatus("success");
    setNewSecondarySecret(newSecret);

    // Build status message
    const messages: string[] = [`Rotation complete for ${npub.slice(0, 12)}...`];
    if (historyToMigrate && historyToMigrate.length > 0 && !historyMigrationFailed) {
      messages.push(`${historyToMigrate.length} history entries migrated.`);
    } else if (historyMigrationFailed) {
      messages.push("Warning: Failed to migrate history.");
    } else if (skipHistoryMigration) {
      messages.push("History migration was skipped.");
    }
    if (cleanupFailed) {
      messages.push("Failed to clear old secret from this device.");
    }
    setMessage(messages.join(" "));
    setNsecInput("");
    setCurrentSecretInput("");
    setDerivedNpub(null);
  };

  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Settings</h1>
        <Button variant="ghost" size="sm" onClick={handleBackToHome}>
          ← Back
        </Button>
      </div>

      <div className="space-y-4">
        <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-md">
          <h2 className="text-sm font-semibold text-amber-700 mb-2">Rotate Player ID</h2>
          <p className="text-xs text-amber-600 mb-4">
            This generates a new player ID AND a new secondary secret.
            Your history will be migrated to the new player ID automatically.
            Only use this if you believe your credentials have been compromised.
          </p>

          {status === "success" && newSecondarySecret ? (
            <div className="space-y-3">
              <div className="p-3 bg-green-500/10 border border-green-500/20 rounded">
                <div className="text-xs text-green-700 font-medium mb-2">
                  Rotation successful! Save your new secondary secret:
                </div>
                <code className="font-mono text-xs block mt-1 select-all break-all text-blue-600">
                  {newSecondarySecret}
                </code>
              </div>
              <div className="text-[10px] text-muted-foreground">
                You will need this secret to unlock this identity on other devices.
              </div>
              <Button
                variant="default"
                size="sm"
                onClick={handleBackToHome}
                className="w-full h-8 text-xs"
              >
                Return to Player
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium">nsec (private key)</label>
                <Input
                  type="password"
                  value={nsecInput}
                  onChange={(e) => handleNsecChange(e.target.value)}
                  placeholder="nsec1..."
                  className="h-8 text-xs font-mono"
                  disabled={status === "loading"}
                />
              </div>

              {derivedNpub && (
                <div className="p-2 bg-muted/50 rounded border border-border">
                  <div className="text-[10px] text-muted-foreground mb-1">This will rotate:</div>
                  <code className="font-mono text-xs block select-all break-all">
                    {derivedNpub}
                  </code>
                </div>
              )}

              {!skipHistoryMigration && (
                <div className="space-y-1">
                  <label className="text-xs font-medium">Current secondary secret</label>
                  <Input
                    type="password"
                    value={currentSecretInput}
                    onChange={(e) => setCurrentSecretInput(e.target.value)}
                    placeholder="Enter your current secondary secret"
                    className="h-8 text-xs font-mono"
                    disabled={status === "loading"}
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Required to decrypt and migrate your history.
                  </p>
                </div>
              )}

              <div className="flex items-start space-x-2">
                <Checkbox
                  id="skip-history"
                  checked={skipHistoryMigration}
                  onCheckedChange={(checked: boolean | "indeterminate") => setSkipHistoryMigration(checked === true)}
                  disabled={status === "loading"}
                />
                <div className="grid gap-1 leading-none">
                  <label
                    htmlFor="skip-history"
                    className="text-xs font-medium cursor-pointer"
                  >
                    Skip history migration
                  </label>
                  <p className="text-[10px] text-red-600">
                    Warning: Your listening history will be permanently lost!
                  </p>
                </div>
              </div>

              {message && status === "error" && (
                <div className="text-xs p-2 rounded bg-red-500/10 text-red-700 border border-red-500/20">
                  {message}
                </div>
              )}

              <Button
                variant="destructive"
                size="sm"
                onClick={handleRotatePlayerId}
                disabled={status === "loading" || !derivedNpub || (!skipHistoryMigration && !currentSecretInput.trim())}
                className="w-full h-8 text-xs"
              >
                {status === "loading" ? "Rotating..." : "Rotate Player ID & Secret"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
