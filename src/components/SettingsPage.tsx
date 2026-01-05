import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getPublicKey } from "nostr-tools/pure";
import {
  decodeNsec,
  encodeNpub,
  generatePlayerId,
  generateSecondarySecret,
} from "@/lib/nostr-crypto";
import { clearSecondarySecret, getStorageScope, getSecondarySecret, setSecondarySecret } from "@/lib/identity";
import { publishPlayerIdToNostr } from "@/lib/nostr-sync";
import { navigate } from "@/lib/navigation";

export function SettingsPage() {
  const [nsecInput, setNsecInput] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [newSecondarySecret, setNewSecondarySecret] = useState<string | null>(null);
  const [derivedNpub, setDerivedNpub] = useState<string | null>(null);

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

    // Generate new secondary secret and player ID
    const newSecret = generateSecondarySecret();
    const newPlayerId = generatePlayerId();

    // Publish to relay
    setStatus("loading");
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

    // Clear the old secondary secret from this device
    try {
      const fingerprint = await getStorageScope(pubkeyHex);
      if (fingerprint) {
        // Save current secret for potential rollback
        const savedSecret = getSecondarySecret(fingerprint);
        try {
          clearSecondarySecret(fingerprint);
        } catch (clearErr) {
          // Attempt rollback if clearing failed
          if (savedSecret) {
            try {
              setSecondarySecret(fingerprint, savedSecret);
            } catch (rollbackErr) {
              console.error("Failed to rollback secret:", rollbackErr);
            }
          }
          console.error("Failed to clear old secret:", clearErr);
        }
      }
    } catch (err) {
      // Log but don't fail - the new credentials are already published
      console.error("Failed to get storage scope:", err);
    }

    setStatus("success");
    setNewSecondarySecret(newSecret);
    setMessage(`Rotation complete for ${npub.slice(0, 12)}...`);
    setNsecInput("");
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
            Your current history will become inaccessible.
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

              {message && status === "error" && (
                <div className="text-xs p-2 rounded bg-red-500/10 text-red-700 border border-red-500/20">
                  {message}
                </div>
              )}

              <Button
                variant="destructive"
                size="sm"
                onClick={handleRotatePlayerId}
                disabled={status === "loading" || !derivedNpub}
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
