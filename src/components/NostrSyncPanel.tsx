import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RELAYS } from "@/lib/nostr-sync";
import { getNpubFingerprint } from "@/lib/identity";
import { generateSecondarySecret } from "@/lib/nostr-crypto";
import { cn } from "@/lib/utils";
import {
  useNostrSession,
  type SessionStatus,
} from "@/hooks/useNostrSession";
import { useNostrSync } from "@/hooks/useNostrSync";
import type { HistoryEntry } from "@/lib/history";

interface NostrSyncPanelProps {
  history: HistoryEntry[];
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onSessionStatusChange?: (status: SessionStatus) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
  onFingerprintChange?: (fingerprint: string | undefined) => void;
  sessionId?: string;
  isPlayingRef?: React.RefObject<boolean>;
}

export function NostrSyncPanel({
  history,
  onHistoryLoaded,
  onSessionStatusChange,
  onTakeOver,
  onRemoteSync,
  onFingerprintChange,
  sessionId,
  isPlayingRef,
}: NostrSyncPanelProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [displayFingerprint, setDisplayFingerprint] = useState<string | undefined>(undefined);

  // Input states
  const [secondarySecretInput, setSecondarySecretInput] = useState("");
  const [nsecInput, setNsecInput] = useState("");
  const [generatedIdentity, setGeneratedIdentity] = useState<{ npub: string; nsec: string; secondarySecret: string } | null>(null);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  // Generation flow: show_credentials -> done
  const [generationStep, setGenerationStep] = useState<"show_credentials" | null>(null);

  const {
    npub,
    pubkeyHex,
    playerId,
    encryptionKeys,
    sessionStatus,
    sessionNotice,
    localSessionId,
    ignoreRemoteUntil,
    setSessionStatus,
    setSessionNotice,
    clearSessionNotice,
    startTakeoverGrace,
    generateNewIdentity,
    submitSecondarySecret,
    setupWithNsec,
    rotatePlayerId,
  } = useNostrSession({ sessionId, onSessionStatusChange });

  const { status, message, lastOperation, setMessage, performSave, performLoad, startSession } =
    useNostrSync({
      history,
      encryptionKeys,
      localSessionId,
      sessionStatus,
      setSessionStatus,
      setSessionNotice,
      clearSessionNotice,
      startTakeoverGrace,
      ignoreRemoteUntil,
      onHistoryLoaded,
      onTakeOver,
      onRemoteSync,
      isPlayingRef,
    });

  const messageRef = useRef<string | null>(null);
  const copyMessageTimerRef = useRef<number | null>(null);
  const copiedLinkTimerRef = useRef<number | null>(null);

  const isLoading = status === "saving" || status === "loading" || sessionStatus === "loading";
  const displayMessage = sessionNotice ?? message;
  const showTimestamp =
    status === "success" &&
    lastOperation?.type &&
    lastOperation.type !== "loaded" &&
    sessionStatus === "active";

  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  useEffect(() => {
    return () => {
      if (copiedLinkTimerRef.current) {
        clearTimeout(copiedLinkTimerRef.current);
        copiedLinkTimerRef.current = null;
      }
      if (copyMessageTimerRef.current) {
        clearTimeout(copyMessageTimerRef.current);
        copyMessageTimerRef.current = null;
      }
    };
  }, []);

  // Compute storage fingerprint from pubkey and notify parent
  useEffect(() => {
    if (!pubkeyHex) {
      onFingerprintChange?.(undefined);
      setDisplayFingerprint(undefined);
      return;
    }
    let cancelled = false;
    getNpubFingerprint(pubkeyHex)
      .then((fingerprint) => {
        if (!cancelled) {
          onFingerprintChange?.(fingerprint);
          // Format with dashes for display: XXXX-XXXX-XXXX-XXXX
          const formatted = fingerprint.toUpperCase().match(/.{1,4}/g)?.join("-");
          setDisplayFingerprint(formatted);
        }
      })
      .catch((err) => {
        console.error("Failed to compute storage fingerprint:", err);
        if (!cancelled) {
          onFingerprintChange?.(undefined);
          setDisplayFingerprint(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkeyHex]);

  const handleStartGeneration = async () => {
    // Generate everything at once and show credentials
    const newSecret = generateSecondarySecret();
    try {
      const identity = await generateNewIdentity();
      setGeneratedIdentity({
        ...identity,
        secondarySecret: newSecret,
      });
      setGenerationStep("show_credentials");
    } catch (err) {
      setSessionNotice(`Failed to generate identity: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleConfirmIdentity = async () => {
    if (!generatedIdentity) return;

    // Now set up with the nsec and secondary secret
    const result = await setupWithNsec(generatedIdentity.nsec, generatedIdentity.secondarySecret);
    if (result) {
      setGeneratedIdentity(null);
      setGenerationStep(null);
      setSecondarySecretInput("");
    }
  };

  const handleCancelGeneration = () => {
    setGenerationStep(null);
    setGeneratedIdentity(null);
    setSecondarySecretInput("");
    // Remove the npub from URL if it was set
    if (typeof window !== "undefined" && window.location.hash) {
      window.location.hash = "";
    }
  };

  const handleSubmitSecondarySecret = async () => {
    const result = await submitSecondarySecret(secondarySecretInput.trim());
    if (result) {
      setSecondarySecretInput("");
    }
  };

  const handleSetupWithNsec = async () => {
    const result = await setupWithNsec(nsecInput.trim(), secondarySecretInput.trim() || undefined);
    if (result) {
      setNsecInput("");
      setSecondarySecretInput("");
      setGeneratedIdentity(null);
    }
  };

  const handleRotatePlayerId = async () => {
    const result = await rotatePlayerId(nsecInput.trim());
    if (result) {
      setNsecInput("");
      setShowRotateConfirm(false);
    }
  };

  const handleCopyLink = async () => {
    if (!npub) return;
    const url = window.location.href;

    try {
      await navigator.clipboard.writeText(url);
      setCopiedLink(true);
      if (copiedLinkTimerRef.current) {
        clearTimeout(copiedLinkTimerRef.current);
      }
      copiedLinkTimerRef.current = window.setTimeout(() => {
        setCopiedLink(false);
        copiedLinkTimerRef.current = null;
      }, 2000);

      if (status !== "success") {
        setMessage("URL copied!");
        if (copyMessageTimerRef.current) {
          clearTimeout(copyMessageTimerRef.current);
        }
        copyMessageTimerRef.current = window.setTimeout(() => {
          if (messageRef.current === "URL copied!") {
            setMessage(null);
          }
          copyMessageTimerRef.current = null;
        }, 3000);
      }
    } catch (err) {
      console.error("Failed to copy link:", err);
      setMessage("Failed to copy URL");
    }
  };

  const handleTakeOver = () => {
    if (!playerId || !encryptionKeys) return;
    performLoad(true); // true = force take over
  };

  const handleStartSession = () => {
    startSession();
  };

  // Render based on session status
  const renderContent = () => {
    // Priority: Show credentials screen if in generation flow (regardless of sessionStatus)
    // This is needed because generateNewIdentity sets the URL hash, which changes sessionStatus
    if (generationStep === "show_credentials" && generatedIdentity) {
      return (
        <div className="space-y-3">
          <div className="p-2 bg-amber-500/10 border border-amber-500/20 rounded text-amber-700 text-xs">
            <strong>Save these credentials now!</strong> You will need them to recover this identity.
          </div>
          <div className="space-y-2 p-2 bg-muted/50 rounded">
            <div>
              <div className="text-[10px] text-muted-foreground font-medium">npub (public, shareable):</div>
              <code className="font-mono text-[10px] block mt-0.5 select-all break-all">
                {generatedIdentity.npub}
              </code>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground font-medium">nsec (private, keep secret):</div>
              <code className="font-mono text-[10px] block mt-0.5 select-all break-all text-red-600">
                {generatedIdentity.nsec}
              </code>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground font-medium">Secondary Secret (for device sync):</div>
              <code className="font-mono text-[10px] block mt-0.5 select-all break-all text-blue-600">
                {generatedIdentity.secondarySecret}
              </code>
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground">
            The secondary secret is needed on each new device. The nsec is only needed for initial setup or player ID rotation.
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={handleConfirmIdentity}
              disabled={isLoading}
              className="flex-1 h-8 text-xs"
            >
              {isLoading ? "Creating..." : "I've Saved These - Continue"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCancelGeneration}
              className="h-8 text-xs"
            >
              Cancel
            </Button>
          </div>
        </div>
      );
    }

    switch (sessionStatus) {
      case "no_npub":
        return (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Generate a new identity to sync your playback history across devices.
            </div>
            <Button
              size="sm"
              variant="default"
              onClick={handleStartGeneration}
              className="w-full h-8 text-xs"
            >
              Generate New Identity
            </Button>
          </div>
        );

      case "needs_secret":
        return (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              Enter your secondary secret to unlock this identity.
            </div>
            <Input
              type="text"
              value={secondarySecretInput}
              onChange={(e) => setSecondarySecretInput(e.target.value)}
              placeholder="Enter secondary secret"
              className="h-8 text-xs font-mono"
              onKeyDown={(e) => e.key === "Enter" && handleSubmitSecondarySecret()}
            />
            <Button
              size="sm"
              variant="default"
              onClick={handleSubmitSecondarySecret}
              disabled={isLoading || !secondarySecretInput.trim()}
              className="w-full h-8 text-xs"
            >
              Unlock
            </Button>
          </div>
        );

      case "loading":
        return (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground text-center">
              Loading...
            </div>
          </div>
        );

      case "needs_setup":
        // This state is reached when user has npub + secondary secret but no player ID on relay
        return (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              No player ID found on relay. Enter your nsec to create one.
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">nsec (private key):</label>
              <Input
                type="password"
                value={nsecInput}
                onChange={(e) => setNsecInput(e.target.value)}
                placeholder="nsec1..."
                className="h-8 text-xs font-mono"
                onKeyDown={(e) => e.key === "Enter" && handleSetupWithNsec()}
              />
            </div>
            <Button
              size="sm"
              variant="default"
              onClick={handleSetupWithNsec}
              disabled={isLoading || !nsecInput.trim()}
              className="w-full h-8 text-xs"
            >
              Create Player ID
            </Button>
          </div>
        );

      case "idle":
        return (
          <div className="space-y-2">
            <Button
              size="sm"
              variant="default"
              onClick={handleStartSession}
              disabled={isLoading}
              className="w-full h-8 text-xs"
            >
              Start Session
            </Button>
            <div className="text-[10px] text-muted-foreground text-center px-1">
              Click Start Session to sync from this device.
            </div>
          </div>
        );

      case "active":
        return (
          <div className="space-y-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleCopyLink}
              className="w-full h-8 text-xs"
              title="Copy URL to sync across devices"
            >
              {copiedLink ? <CheckIcon className="w-3.5 h-3.5 mr-1" /> : <LinkIcon className="w-3.5 h-3.5 mr-1" />}
              {copiedLink ? "Copied" : "Copy Sync URL"}
            </Button>
            <div className="text-[10px] text-muted-foreground text-center px-1">
              Auto-save enabled. Bookmark this URL.
            </div>
          </div>
        );

      case "stale":
        return (
          <div className="space-y-2">
            <Button
              size="sm"
              variant="default"
              onClick={handleTakeOver}
              disabled={isLoading}
              className="w-full h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white"
            >
              Take Over Session
            </Button>
          </div>
        );

      case "invalid":
        return (
          <div className="space-y-2">
            <div className="text-xs text-red-600">
              Invalid npub format. Check the URL or generate a new identity.
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={handleStartGeneration}
              className="w-full h-8 text-xs"
            >
              Generate New Identity
            </Button>
          </div>
        );

      default:
        return null;
    }
  };

  const getStatusBadge = () => {
    if (!npub) return null;

    switch (sessionStatus) {
      case "active":
        return <span className="text-[10px] text-green-500 font-bold px-1.5 py-0.5 bg-green-500/10 rounded-full">ACTIVE</span>;
      case "stale":
        return <span className="text-[10px] text-amber-500 font-bold px-1.5 py-0.5 bg-amber-500/10 rounded-full">STALE</span>;
      case "idle":
        return <span className="text-[10px] text-blue-500 font-bold px-1.5 py-0.5 bg-blue-500/10 rounded-full">READY</span>;
      case "loading":
        return <span className="text-[10px] text-muted-foreground font-bold px-1.5 py-0.5 bg-muted/50 rounded-full">LOADING</span>;
      case "needs_secret":
        return <span className="text-[10px] text-amber-500 font-bold px-1.5 py-0.5 bg-amber-500/10 rounded-full">LOCKED</span>;
      case "needs_setup":
        return <span className="text-[10px] text-purple-500 font-bold px-1.5 py-0.5 bg-purple-500/10 rounded-full">SETUP</span>;
      case "invalid":
        return <span className="text-[10px] text-red-500 font-bold px-1.5 py-0.5 bg-red-500/10 rounded-full">ERROR</span>;
      default:
        return null;
    }
  };

  return (
    <div className="border-t pt-3 mt-3 space-y-2">
      <div className="text-xs font-medium text-muted-foreground flex justify-between items-center">
        <span>Nostr Sync</span>
        <div className="flex items-center gap-2">
          {getStatusBadge()}
        </div>
      </div>

      {renderContent()}

      <div
        className={cn("text-xs p-2 rounded-md transition-colors",
          !displayMessage && "invisible",
          displayMessage && "bg-muted/50",
          status === "error" && "text-destructive bg-destructive/5 border border-destructive/10",
          status !== "error" && "text-muted-foreground",
          sessionStatus === "stale" && displayMessage && "bg-amber-500/10 text-amber-600 border border-amber-500/20",
          sessionStatus === "idle" && displayMessage && "bg-blue-500/10 text-blue-600 border border-blue-500/20",
          sessionStatus === "invalid" && displayMessage && "bg-red-500/10 text-red-600 border border-red-500/20"
        )}
      >
        {displayMessage}
        {showTimestamp && (
          <span className="block mt-1 opacity-75 text-[10px]">
            {lastOperation.type === "saved" ? "Saved" : "Loaded"} at {lastOperation.timestamp}
          </span>
        )}
      </div>

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
            {npub && (
              <div className="pt-2">
                <div className="font-medium">npub:</div>
                <code className="font-mono text-[10px] block mt-0.5 select-all break-all">
                  {npub}
                </code>
                <div className="font-medium mt-1">Storage Fingerprint:</div>
                <code className="font-mono text-[10px] block mt-0.5 select-all">
                  {displayFingerprint || "..."}
                </code>
                <div className="font-medium mt-1">Session ID:</div>
                <code className="font-mono text-[10px] block mt-0.5 select-all truncate">
                  {localSessionId}
                </code>
                {playerId && (
                  <>
                    <div className="font-medium mt-1">Player ID:</div>
                    <code className="font-mono text-[10px] block mt-0.5 select-all truncate">
                      {playerId.slice(0, 16)}...
                    </code>
                  </>
                )}
                {sessionStatus === "active" && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => performSave(history)}
                      disabled={isLoading}
                      className="mt-3 w-full h-7 text-[10px]"
                    >
                      {status === "saving" ? "Saving..." : "Force Sync"}
                    </Button>

                    {/* Rotate Player ID */}
                    <div className="mt-3 pt-3 border-t border-border/50">
                      {!showRotateConfirm ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setShowRotateConfirm(true)}
                          className="w-full h-7 text-[10px] text-muted-foreground hover:text-amber-600"
                        >
                          Rotate Player ID
                        </Button>
                      ) : (
                        <div className="space-y-2">
                          <div className="text-[10px] text-amber-600">
                            Warning: This will make your current history inaccessible.
                          </div>
                          <Input
                            type="password"
                            value={nsecInput}
                            onChange={(e) => setNsecInput(e.target.value)}
                            placeholder="Enter nsec to confirm"
                            className="h-7 text-[10px] font-mono"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={handleRotatePlayerId}
                              disabled={isLoading || !nsecInput.trim()}
                              className="flex-1 h-7 text-[10px]"
                            >
                              Confirm Rotate
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setShowRotateConfirm(false);
                                setNsecInput("");
                              }}
                              className="h-7 text-[10px]"
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
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
