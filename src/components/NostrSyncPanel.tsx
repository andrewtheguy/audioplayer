import { useState } from "react";
import { Button } from "@/components/ui/button";
import { generateSecret } from "@/lib/pin-crypto";
import { RELAYS } from "@/lib/nostr-sync";
import type { HistoryEntry } from "@/lib/history";
import { cn } from "@/lib/utils";
import {
  useNostrSession,
  type SessionStatus,
} from "@/hooks/useNostrSession";
import { useNostrSync } from "@/hooks/useNostrSync";

interface NostrSyncPanelProps {
  history: HistoryEntry[];
  onHistoryLoaded: (merged: HistoryEntry[]) => void;
  onSessionStatusChange?: (status: SessionStatus) => void;
  onTakeOver?: (remoteHistory: HistoryEntry[]) => void;
  sessionId?: string;
}

export function NostrSyncPanel({
  history,
  onHistoryLoaded,
  onSessionStatusChange,
  onTakeOver,
  sessionId,
}: NostrSyncPanelProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const {
    secret,
    sessionStatus,
    sessionNotice,
    localSessionId,
    setSessionStatus,
    setSessionNotice,
    clearSessionNotice,
    startTakeoverGrace,
  } = useNostrSession({ sessionId, onSessionStatusChange });
  const { status, message, lastOperation, setMessage, performSave, performLoad } =
    useNostrSync({
      history,
      secret,
      localSessionId,
      sessionStatus,
      setSessionStatus,
      setSessionNotice,
      clearSessionNotice,
      startTakeoverGrace,
      onHistoryLoaded,
      onTakeOver,
    });

  const isLoading = status === "saving" || status === "loading";
  const displayMessage = sessionNotice ?? message;

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
      if (status !== "success") {
          setMessage("Link copied to clipboard!");
          // Reset message after delay if it was just the copy confirmation
          setTimeout(() => {
              // We need to check the current status via a ref or functional update if we were inside the effect,
              // but here we just want to clear if it hasn't changed to something important.
              // However, since we can't easily check 'current' status inside timeout without refs,
              // we'll just clear if the message is still the copy message.
              setMessage((prev) =>
                prev === "Link copied to clipboard!" ? null : prev
              );
          }, 3000);
      }
    } catch {
      setMessage("Failed to copy link");
    }
  };

  const handleTakeOver = () => {
      if (!secret) return;
      performLoad(secret, true); // true = force take over
  };

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
                variant="default"
                onClick={handleTakeOver}
                disabled={isLoading}
                className="w-full h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white"
              >
                  Take Over Session
              </Button>
          ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={handleCopyLink}
                className="w-full h-8 text-xs"
                title="Copy link to share or save"
              >
                 {copiedLink ? <CheckIcon className="w-3.5 h-3.5 mr-1" /> : <LinkIcon className="w-3.5 h-3.5 mr-1" />}
                 {copiedLink ? "Copied" : "Copy Link"}
              </Button>
          )}
          
           <div className="text-[10px] text-muted-foreground text-center px-1">
             {sessionStatus === 'active' ? 'Auto-save enabled.' : 'Bookmark this URL to access your history.'}
           </div>
        </div>
      )}

      {displayMessage && (
        <div
          className={cn("text-xs p-2 rounded-md bg-muted/50 transition-colors", 
            status === "error" && "text-destructive bg-destructive/5 border border-destructive/10",
            status !== "error" && "text-muted-foreground",
            sessionStatus === 'stale' && "bg-amber-500/10 text-amber-600 border border-amber-500/20"
          )}
        >
          {displayMessage}
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
                    {sessionStatus === 'active' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => performSave(secret, history)}
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
