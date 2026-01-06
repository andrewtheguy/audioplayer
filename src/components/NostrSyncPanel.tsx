import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RELAYS } from "@/lib/nostr-sync";
import { cn } from "@/lib/utils";
import {
  useNostrSession,
  type SessionStatus,
} from "@/hooks/useNostrSession";
import { useNostrSync } from "@/hooks/useNostrSync";
import { useAuth } from "@/contexts/AuthContext";
import type { HistoryEntry } from "@/lib/history";

interface NostrSyncPanelProps {
  history: HistoryEntry[];
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onSessionStatusChange?: (status: SessionStatus) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
  onRemoteSync?: (remoteHistory: HistoryEntry[]) => void;
  sessionId?: string;
  isPlayingRef?: React.RefObject<boolean>;
}

export function NostrSyncPanel({
  history,
  onHistoryLoaded,
  onSessionStatusChange,
  onTakeOver,
  onRemoteSync,
  sessionId,
  isPlayingRef,
}: NostrSyncPanelProps) {
  const { logout, npub: authNpub } = useAuth();
  const [showDetails, setShowDetails] = useState(false);

  // Input states
  const [nsecInput, setNsecInput] = useState("");
  const [nsecTouched, setNsecTouched] = useState(false);

  // Validate nsec format (starts with "nsec1" and has reasonable length)
  const isValidNsecFormat = (value: string): boolean => {
    const trimmed = value.trim();
    return trimmed.startsWith("nsec1") && trimmed.length >= 60;
  };

  const nsecError = nsecTouched && nsecInput.trim() && !isValidNsecFormat(nsecInput)
    ? "Must start with 'nsec1' and be at least 60 characters"
    : null;

  const {
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
    setupWithNsec,
  } = useNostrSession({
    sessionId,
    onSessionStatusChange,
  });

  const { status, message, lastOperation, performSave, performLoad, startSession } =
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
      if (copyMessageTimerRef.current) {
        clearTimeout(copyMessageTimerRef.current);
        copyMessageTimerRef.current = null;
      }
    };
  }, []);

  const handleSetupWithNsec = async () => {
    if (!isValidNsecFormat(nsecInput)) {
      setNsecTouched(true);
      return;
    }
    const result = await setupWithNsec(nsecInput.trim());
    if (result) {
      setNsecInput("");
      setNsecTouched(false);
    }
  };

  const handleTakeOver = () => {
    if (!playerId || !encryptionKeys) return;
    performLoad(true); // true = force take over
  };

  const handleStartSession = () => {
    startSession();
  };

  const handleLogout = () => {
    logout();
  };

  // Render based on session status
  const renderContent = () => {
    switch (sessionStatus) {
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
                onBlur={() => setNsecTouched(true)}
                placeholder="nsec1..."
                className={cn("h-8 text-xs font-mono", nsecError && "border-destructive")}
                onKeyDown={(e) => e.key === "Enter" && isValidNsecFormat(nsecInput) && handleSetupWithNsec()}
              />
              {nsecError && (
                <div className="text-[10px] text-destructive">{nsecError}</div>
              )}
            </div>
            <Button
              size="sm"
              variant="default"
              onClick={handleSetupWithNsec}
              disabled={isLoading || !isValidNsecFormat(nsecInput)}
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
            <div className="text-[10px] text-muted-foreground text-center px-1">
              Session active. Auto-save enabled.
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

      default:
        return null;
    }
  };

  const getStatusBadge = () => {
    switch (sessionStatus) {
      case "active":
        return <span className="text-[10px] text-green-500 font-bold px-1.5 py-0.5 bg-green-500/10 rounded-full">ACTIVE</span>;
      case "stale":
        return <span className="text-[10px] text-amber-500 font-bold px-1.5 py-0.5 bg-amber-500/10 rounded-full">STALE</span>;
      case "idle":
        return <span className="text-[10px] text-blue-500 font-bold px-1.5 py-0.5 bg-blue-500/10 rounded-full">READY</span>;
      case "loading":
        return <span className="text-[10px] text-muted-foreground font-bold px-1.5 py-0.5 bg-muted/50 rounded-full">LOADING</span>;
      case "needs_setup":
        return <span className="text-[10px] text-purple-500 font-bold px-1.5 py-0.5 bg-purple-500/10 rounded-full">SETUP</span>;
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
        className={cn("text-xs p-2 rounded-md transition-colors min-h-[2.5rem]",
          !displayMessage && "invisible",
          displayMessage && "bg-muted/50",
          status === "error" && "text-destructive bg-destructive/5 border border-destructive/10",
          status !== "error" && "text-muted-foreground",
          sessionStatus === "stale" && displayMessage && "bg-amber-500/10 text-amber-600 border border-amber-500/20",
          sessionStatus === "idle" && displayMessage && "bg-blue-500/10 text-blue-600 border border-blue-500/20"
        )}
      >
        {displayMessage}
        <span className={cn("block mt-1 opacity-75 text-[10px]", !showTimestamp && "invisible")}>
          {showTimestamp && lastOperation ? `${lastOperation.type === "saved" ? "Saved" : "Loaded"} at ${lastOperation.timestamp}` : "\u00A0"}
        </span>
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
            {authNpub && (
              <div className="pt-2">
                <div className="font-medium">npub:</div>
                <code className="font-mono text-[10px] block mt-0.5 select-all break-all">
                  {authNpub}
                </code>
                <div className="font-medium mt-1">Session ID:</div>
                <code className="font-mono text-[10px] block mt-0.5 select-all truncate">
                  {localSessionId}
                </code>
                {sessionStatus === "active" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => performSave(history)}
                    disabled={isLoading}
                    className="mt-3 w-full h-7 text-[10px]"
                  >
                    {status === "saving" ? "Saving..." : "Force Sync"}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Logout button */}
      {authNpub && (
        <div className="pt-2 border-t">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleLogout}
            className="w-full h-8 text-xs text-muted-foreground hover:text-destructive"
          >
            Logout
          </Button>
        </div>
      )}
    </div>
  );
}
