import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";

const STORAGE_KEY = "audioplayer-history";
const MAX_HISTORY_ENTRIES = 100;
const SAVE_INTERVAL_MS = 5000;

interface HistoryEntry {
  url: string;
  lastPlayedAt: string;
  position: number;
}

interface AudioPlayerProps {
  initialUrl?: string;
}

// localStorage utility functions
function getHistory(): HistoryEntry[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: HistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Storage full or unavailable
  }
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || !isFinite(seconds)) return "00:00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function truncateUrl(url: string, maxLength = 40): string {
  if (url.length <= maxLength) return url;
  return url.slice(0, maxLength - 3) + "...";
}

export function AudioPlayer({ initialUrl = "" }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const saveIntervalRef = useRef<number | null>(null);
  const currentUrlRef = useRef<string>("");

  const [url, setUrl] = useState(initialUrl);
  const [nowPlaying, setNowPlaying] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pendingSeekPosition, setPendingSeekPosition] = useState<number | null>(null);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  // Load history on mount
  useEffect(() => {
    setHistory(getHistory());
  }, []);

  // Save current position to history
  const saveCurrentPosition = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !currentUrlRef.current || !isFinite(audio.currentTime)) return;

    setHistory((prev) => {
      const existingIndex = prev.findIndex((h) => h.url === currentUrlRef.current);
      const entry: HistoryEntry = {
        url: currentUrlRef.current,
        lastPlayedAt: new Date().toISOString(),
        position: audio.currentTime,
      };

      let newHistory: HistoryEntry[];
      if (existingIndex >= 0) {
        newHistory = [entry, ...prev.filter((_, i) => i !== existingIndex)];
      } else {
        newHistory = [entry, ...prev].slice(0, MAX_HISTORY_ENTRIES);
      }

      saveHistory(newHistory);
      return newHistory;
    });
  }, []);

  // Start/stop save interval based on playing state
  useEffect(() => {
    if (isPlaying && currentUrlRef.current) {
      saveIntervalRef.current = window.setInterval(saveCurrentPosition, SAVE_INTERVAL_MS);
    } else {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
        saveIntervalRef.current = null;
      }
    }

    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
    };
  }, [isPlaying, saveCurrentPosition]);

  // Save on unmount
  useEffect(() => {
    return () => {
      saveCurrentPosition();
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, [saveCurrentPosition]);

  // Handle pending seek after load
  useEffect(() => {
    if (isLoaded && pendingSeekPosition !== null) {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = pendingSeekPosition;
        setCurrentTime(pendingSeekPosition);
      }
      setPendingSeekPosition(null);
    }
  }, [isLoaded, pendingSeekPosition]);

  const loadStream = (streamUrl?: string, seekPosition?: number) => {
    const urlToLoad = streamUrl ?? url;
    if (!urlToLoad.trim()) {
      setError("Please enter a URL");
      return;
    }

    // Save current position before switching
    if (currentUrlRef.current && currentUrlRef.current !== urlToLoad) {
      saveCurrentPosition();
    }

    setError(null);
    setIsLoaded(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    if (seekPosition !== undefined) {
      setPendingSeekPosition(seekPosition);
    }

    const audio = audioRef.current;
    if (!audio) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    currentUrlRef.current = urlToLoad;
    setUrl(urlToLoad);

    const onLoadSuccess = () => {
      setIsLoaded(true);
      setNowPlaying(urlToLoad);
      setUrl("");
    };

    if (urlToLoad.includes(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;

        hls.loadSource(urlToLoad);
        hls.attachMedia(audio);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          onLoadSuccess();
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            setError(`HLS Error: ${data.type} - ${data.details}`);
            setIsLoaded(false);
          }
        });
      } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        audio.src = urlToLoad;
        onLoadSuccess();
      } else {
        setError("HLS is not supported in this browser");
      }
    } else {
      audio.src = urlToLoad;
      onLoadSuccess();
    }
  };

  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch((e) => {
        setError(`Playback error: ${e.message}`);
      });
    }
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (audio) {
      setCurrentTime(audio.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (audio) {
      setDuration(audio.duration);
    }
  };

  const handlePause = () => {
    setIsPlaying(false);
    saveCurrentPosition();
  };

  const handleSeek = (value: number[]) => {
    const audio = audioRef.current;
    if (audio && isFinite(value[0])) {
      audio.currentTime = value[0];
      setCurrentTime(value[0]);
    }
  };

  const handleVolumeChange = (value: number[]) => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = value[0];
      setVolume(value[0]);
    }
  };

  const handleHistorySelect = (entry: HistoryEntry) => {
    loadStream(entry.url, entry.position);
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedUrl(text);
      setTimeout(() => setCopiedUrl(null), 500);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopiedUrl(text);
      setTimeout(() => setCopiedUrl(null), 500);
    }
  };

  const handleCopyEntry = (e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    copyToClipboard(url);
  };

  const handleDeleteEntry = (e: React.MouseEvent, urlToDelete: string) => {
    e.stopPropagation();
    if (!confirm("Delete this entry from history?")) return;
    setHistory((prev) => {
      const newHistory = prev.filter((h) => h.url !== urlToDelete);
      saveHistory(newHistory);
      return newHistory;
    });
  };

  const handleClearHistory = () => {
    if (!confirm("Clear all history? This cannot be undone.")) return;
    setHistory([]);
    saveHistory([]);
  };

  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-6">
      {/* URL Input */}
      <div className="space-y-2">
        <label className="text-sm font-medium">HLS Stream URL</label>
        <div className="flex gap-2">
          <Input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Enter HLS URL (.m3u8)"
            onKeyDown={(e) => e.key === "Enter" && loadStream()}
          />
          <Button onClick={() => loadStream()}>Load</Button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
          {error}
        </div>
      )}

      {/* Now Playing */}
      {nowPlaying && (
        <div className="space-y-1">
          <label className="text-sm font-medium">Now Playing</label>
          <div className="flex items-center gap-2">
            <div className="text-sm text-muted-foreground truncate flex-1" title={nowPlaying}>
              {nowPlaying}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyToClipboard(nowPlaying)}
              className={`h-6 w-6 p-0 shrink-0 ${copiedUrl === nowPlaying ? "text-green-500" : "text-muted-foreground hover:text-foreground"}`}
              title={copiedUrl === nowPlaying ? "Copied!" : "Copy URL"}
            >
              {copiedUrl === nowPlaying ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      )}

      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlaying(true)}
        onPause={handlePause}
        onEnded={() => setIsPlaying(false)}
        onError={() => setError("Audio playback error")}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-center gap-4">
          <Button
            size="lg"
            onClick={togglePlayPause}
            disabled={!isLoaded}
            className="w-16 h-16 rounded-full"
          >
            {isPlaying ? (
              <PauseIcon className="w-6 h-6" />
            ) : (
              <PlayIcon className="w-6 h-6" />
            )}
          </Button>
        </div>

        <div className="space-y-2">
          <Slider
            value={[currentTime]}
            max={duration || 100}
            step={1}
            onValueChange={handleSeek}
            disabled={!isLoaded || !isFinite(duration)}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <VolumeIcon className="w-4 h-4 text-muted-foreground" />
          <Slider
            value={[volume]}
            max={1}
            step={0.01}
            onValueChange={handleVolumeChange}
            className="w-24"
          />
        </div>
      </div>

      {/* History List */}
      {history.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">History</label>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearHistory}
              className="text-xs text-muted-foreground hover:text-destructive"
            >
              Clear All
            </Button>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1 border rounded-md p-2">
            {history.map((entry) => (
              <div
                key={entry.url}
                onClick={() => handleHistorySelect(entry)}
                className="flex items-center justify-between p-2 rounded hover:bg-accent cursor-pointer group"
              >
                <div className="flex-1 min-w-0 mr-2">
                  <div className="text-sm truncate" title={entry.url}>
                    {truncateUrl(entry.url)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatDate(entry.lastPlayedAt)} &middot; {formatTime(entry.position)}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => handleCopyEntry(e, entry.url)}
                    className={`h-6 w-6 p-0 ${copiedUrl === entry.url ? "opacity-100 text-green-500" : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"}`}
                    title={copiedUrl === entry.url ? "Copied!" : "Copy URL"}
                  >
                    {copiedUrl === entry.url ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => handleDeleteEntry(e, entry.url)}
                    className="opacity-0 group-hover:opacity-100 h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <XIcon className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function VolumeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
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
