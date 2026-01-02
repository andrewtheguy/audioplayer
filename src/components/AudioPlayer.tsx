import { useEffect, useRef, useState, useCallback } from "react";
import Hls from "hls.js";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { NostrSyncPanel } from "./NostrSyncPanel";
import {
  HISTORY_TIMESTAMP_KEY,
  MAX_HISTORY_ENTRIES,
  getHistory,
  saveHistory,
  type HistoryEntry,
} from "@/lib/history";

const SAVE_INTERVAL_MS = 5000;

interface AudioPlayerProps {
  initialUrl?: string;
}

interface AudioPlayerInnerProps extends AudioPlayerProps {
  takeoverEntry?: HistoryEntry | null;
  onTakeoverApplied?: () => void;
  onRequestReset?: (entry: HistoryEntry | null) => void;
  sessionId?: string;
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

function normalizeTitle(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function AudioPlayer({ initialUrl = "" }: AudioPlayerProps) {
  const [resetKey, setResetKey] = useState(0);
  const [takeoverEntry, setTakeoverEntry] = useState<HistoryEntry | null>(null);
  const [sessionId] = useState(() => crypto.randomUUID());

  const handleRequestReset = useCallback((entry: HistoryEntry | null) => {
    setTakeoverEntry(entry);
    setResetKey((prev) => prev + 1);
  }, []);

  return (
    <AudioPlayerInner
      key={resetKey}
      initialUrl={initialUrl}
      takeoverEntry={takeoverEntry}
      onTakeoverApplied={() => setTakeoverEntry(null)}
      onRequestReset={handleRequestReset}
      sessionId={sessionId}
    />
  );
}

function AudioPlayerInner({
  initialUrl = "",
  takeoverEntry,
  onTakeoverApplied,
  onRequestReset,
  sessionId,
}: AudioPlayerInnerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const saveIntervalRef = useRef<number | null>(null);
  const currentUrlRef = useRef<string>("");
  const currentTitleRef = useRef<string | undefined>(undefined);
  const isLiveStreamRef = useRef<boolean>(false);
  const isPlayingRef = useRef<boolean>(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainRef = useRef<number>(1);
  const pausedAtTimestampRef = useRef<number | null>(null);
  const pendingSeekTimerRef = useRef<number | null>(null);
  const pendingSeekAttemptsRef = useRef<number>(0);
  const seekingToTargetRef = useRef<boolean>(false);
  const pendingSeekPositionRef = useRef<number | null>(null);

  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState("");
  const [nowPlayingUrl, setNowPlayingUrl] = useState<string | null>(null);
  const [nowPlayingTitle, setNowPlayingTitle] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => getHistory());
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [isLiveStream, setIsLiveStream] = useState(false);
  const [gainEnabled, setGainEnabled] = useState(false);
  const [gain, setGain] = useState(1); // 1 = 100%
  const [isSessionStale, setIsSessionStale] = useState(false);
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [showLoadInputs, setShowLoadInputs] = useState(true);
  const shouldShowLoadInputs = !nowPlayingUrl || showLoadInputs;
  const [isEditingNowPlaying, setIsEditingNowPlaying] = useState(false);
  const [nowPlayingTitleDraft, setNowPlayingTitleDraft] = useState("");
  const wasSessionStaleRef = useRef(false);

  // Keep refs in sync with state for use in callbacks
  useEffect(() => {
    isLiveStreamRef.current = isLiveStream;
  }, [isLiveStream]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    gainRef.current = gain;
  }, [gain]);

  // Clear pause timestamp when playing starts
  useEffect(() => {
    if (isPlaying) {
      pausedAtTimestampRef.current = null;
    }
  }, [isPlaying]);

  // Setup Web Audio API for gain control
  const setupGainNode = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || sourceNodeRef.current) return; // Already setup

    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    const gainNode = ctx.createGain();

    source.connect(gainNode);
    gainNode.connect(ctx.destination);

    audioContextRef.current = ctx;
    sourceNodeRef.current = source;
    gainNodeRef.current = gainNode;

    ctx.resume().catch((err) => {
      console.error("Failed to resume AudioContext:", err);
    });
  }, []);

  // Apply gain value: 1 if disabled, gain value if enabled
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = gainEnabled ? gain : 1;
    }
  }, [gain, gainEnabled]);

  // Handle gain toggle
  const handleGainToggle = useCallback(() => {
    if (!gainEnabled) {
      setupGainNode();
    }
    setGainEnabled(!gainEnabled);
  }, [gainEnabled, setupGainNode]);

  // Save history entry with an explicit position (skip for live streams)
  const saveHistoryEntry = useCallback((position?: number) => {
    const audio = audioRef.current;
    if (!audio || !currentUrlRef.current) return;
    const resolvedPosition = position ?? audio.currentTime;
    if (!isFinite(resolvedPosition)) return;
    if (isLiveStreamRef.current) return; // Don't save position for live streams

    setHistory((prev) => {
      const existingIndex = prev.findIndex((h) => h.url === currentUrlRef.current);
      const existingEntry = existingIndex >= 0 ? prev[existingIndex] : null;
      const resolvedTitle = currentTitleRef.current ?? existingEntry?.title;
      const entry: HistoryEntry = {
        url: currentUrlRef.current,
        title: resolvedTitle,
        lastPlayedAt: new Date().toISOString(),
        position: resolvedPosition,
        // Save gain if currently using gain control, otherwise preserve existing
        gain: gainRef.current !== 1 ? gainRef.current : existingEntry?.gain,
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

  // Start/stop save interval based on playing state (skip for live streams)
  useEffect(() => {
    if (isPlaying && currentUrlRef.current && !isLiveStream) {
      saveIntervalRef.current = window.setInterval(
        saveHistoryEntry,
        SAVE_INTERVAL_MS
      );
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
  }, [isPlaying, isLiveStream, saveHistoryEntry]);

  // Save on unmount
  useEffect(() => {
    return () => {
      saveHistoryEntry();
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch((err) => {
          console.error("Failed to close AudioContext:", err);
        });
        audioContextRef.current = null;
      }
      if (pendingSeekTimerRef.current) {
        clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
    };
  }, [saveHistoryEntry]);

  // Load directly from a history entry (with position)
  const loadFromHistory = useCallback((entry: HistoryEntry, options?: { forceReset?: boolean }) => {
    // Save current position before switching
    if (currentUrlRef.current && currentUrlRef.current !== entry.url) {
      saveHistoryEntry();
    }

    setError(null);
    setIsLoaded(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setIsLiveStream(false);
    // Reset gain enabled (user must re-enable manually), but load saved gain value
    setGainEnabled(false);
    setGain(entry.gain ?? 1);

    // Set pending seek position from history entry
    pendingSeekPositionRef.current = entry.position;
    pendingSeekAttemptsRef.current = 0;
    seekingToTargetRef.current = false;
    if (pendingSeekTimerRef.current) {
      clearTimeout(pendingSeekTimerRef.current);
      pendingSeekTimerRef.current = null;
    }
    const urlToLoad = entry.url;

    const audio = audioRef.current;
    if (!audio) return;

    if (options?.forceReset) {
      audio.pause();
      audio.src = "";
      audio.load();
    }

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    currentUrlRef.current = urlToLoad;
    currentTitleRef.current = entry.title;
    setUrl(urlToLoad);

    const onLoadSuccess = () => {
      setIsLoaded(true);
      setNowPlayingUrl(urlToLoad);
      setNowPlayingTitle(entry.title ?? null);
      setIsEditingNowPlaying(false);
      setNowPlayingTitleDraft("");
      setTitle("");
      setUrl("");
      setShowLoadInputs(false);
    };

    if (urlToLoad.includes(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;

        hls.loadSource(urlToLoad);
        hls.attachMedia(audio);

        let hasCalledLoadSuccess = false;
        hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          // Live if: data.details.live is true
          const isLive = data.details.live === true;
          setIsLiveStream(isLive);
          if (isLive) {
            pendingSeekPositionRef.current = null; // Don't seek for live streams
          }
          // Only mark as loaded after we know the stream type (once)
          if (!hasCalledLoadSuccess) {
            hasCalledLoadSuccess = true;
            onLoadSuccess();
          }
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            setError(`HLS Error: ${data.type} - ${data.details}`);
            setIsLoaded(false);
          }
        });
      } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        // Native HLS support (Safari) - can't detect live status from manifest
        // Assume VOD for native playback since we can't access manifest directly
        audio.src = urlToLoad;
        onLoadSuccess();
      } else {
        setError("HLS is not supported in this browser");
      }
    } else {
      audio.src = urlToLoad;
      onLoadSuccess();
    }
  }, [saveHistoryEntry]);

  useEffect(() => {
    if (!takeoverEntry) return;
    // Defer to next tick so the component is mounted before we mutate state/DOM.
    const timeoutId = window.setTimeout(() => {
      loadFromHistory(takeoverEntry, { forceReset: true });
      onTakeoverApplied?.();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [takeoverEntry, loadFromHistory, onTakeoverApplied]);

  // Load a URL - redirects to loadFromHistory if URL exists in history
  const loadUrl = (urlToLoad: string) => {
    const resolvedTitle = normalizeTitle(title);
    const historyEntry = history.find((h) => h.url === urlToLoad);
    if (historyEntry) {
      const updatedEntry =
        resolvedTitle && resolvedTitle !== historyEntry.title
          ? { ...historyEntry, title: resolvedTitle }
          : historyEntry;
      if (updatedEntry !== historyEntry) {
        setHistory((prev) => {
          const newHistory = [updatedEntry, ...prev.filter((h) => h.url !== updatedEntry.url)];
          saveHistory(newHistory);
          return newHistory;
        });
      }
      loadFromHistory(updatedEntry);
      return;
    }

    // Fresh load (no history entry)
    if (currentUrlRef.current && currentUrlRef.current !== urlToLoad) {
      saveHistoryEntry();
    }

    setError(null);
    setIsLoaded(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setIsLiveStream(false);
    isLiveStreamRef.current = false;
    setGainEnabled(false);
    setGain(1);
    pendingSeekPositionRef.current = null;

    const audio = audioRef.current;
    if (!audio) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    currentUrlRef.current = urlToLoad;
    currentTitleRef.current = resolvedTitle;

    const onLoadSuccess = () => {
      setIsLoaded(true);
      setNowPlayingUrl(urlToLoad);
      setNowPlayingTitle(resolvedTitle ?? null);
      setIsEditingNowPlaying(false);
      setNowPlayingTitleDraft("");
      setTitle("");
      setUrl("");
      setShowLoadInputs(false);
      // Add to history immediately upon load success
      saveHistoryEntry(0);
    };

    if (urlToLoad.includes(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;

        hls.loadSource(urlToLoad);
        hls.attachMedia(audio);

        let hasCalledLoadSuccess = false;
        hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          const isLive = data.details.live === true;
          setIsLiveStream(isLive);
          isLiveStreamRef.current = isLive;
          if (!hasCalledLoadSuccess) {
            hasCalledLoadSuccess = true;
            onLoadSuccess();
          }
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

  // Load from URL input
  const loadStream = () => {
    const urlToLoad = url.trim();
    if (!urlToLoad) {
      setError("Please enter a URL");
      return;
    }
    loadUrl(urlToLoad);
  };

  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      const ctx = audioContextRef.current;
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch((err) => {
          console.error("Failed to resume AudioContext:", err);
        });
      }
      audio.play().catch((e) => {
        setError(`Playback error: ${e.message}`);
      });
    }
  };

  const handleTimeUpdate = () => {
    const audio = audioRef.current;
    if (audio) {
      setCurrentTime(audio.currentTime);
      if (pendingSeekPositionRef.current !== null) {
        applyPendingSeek();
      }
    }
  };

  const schedulePendingSeekRetry = () => {
    // seekingToTargetRef tracks an in-flight programmatic seek (block duplicates);
    // pendingSeekTimerRef schedules retries when seeked doesn't fire and is cleared on success/max attempts.
    if (pendingSeekTimerRef.current) return;
    pendingSeekTimerRef.current = window.setTimeout(() => {
      pendingSeekTimerRef.current = null;
      applyPendingSeek();
    }, 250);
  };

  const applyPendingSeek = () => {
    const audio = audioRef.current;
    const pending = pendingSeekPositionRef.current;
    if (!audio || pending === null) return;
    if (isLiveStreamRef.current) {
      pendingSeekPositionRef.current = null;
      seekingToTargetRef.current = false;
      return;
    }
    if (!isFinite(pending) || pending < 0) {
      pendingSeekPositionRef.current = null;
      seekingToTargetRef.current = false;
      return;
    }
    if (audio.seekable.length === 0) {
      schedulePendingSeekRetry();
      return;
    }
    if (pendingSeekAttemptsRef.current >= 20) {
      console.warn("Seek to saved position failed after max retries");
      pendingSeekPositionRef.current = null;
      seekingToTargetRef.current = false;
      return;
    }

    // Check if we're already at the target position (from a previous successful seek)
    if (Math.abs(audio.currentTime - pending) <= 0.5) {
      pendingSeekPositionRef.current = null;
      seekingToTargetRef.current = false;
      if (pendingSeekTimerRef.current) {
        clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
      return;
    }

    // If we're already seeking to target, wait for seeked event
    if (seekingToTargetRef.current) {
      return;
    }

    pendingSeekAttemptsRef.current += 1;
    seekingToTargetRef.current = true;
    audio.currentTime = pending;
    setCurrentTime(pending);

    // Schedule a retry in case seeked event doesn't fire
    schedulePendingSeekRetry();
  };

  const handleRemoteSync = (remoteHistory: HistoryEntry[]) => {
    const entry = remoteHistory[0];
    if (!entry) return;

    if (isSessionStale) {
      currentUrlRef.current = entry.url;
      currentTitleRef.current = entry.title;
      setNowPlayingUrl(entry.url);
      setNowPlayingTitle(entry.title ?? null);
      setCurrentTime(isFinite(entry.position) ? entry.position : 0);
      return;
    }

    if (currentUrlRef.current && currentUrlRef.current === entry.url && audioRef.current) {
      if (!isLiveStreamRef.current && isFinite(entry.position)) {
        const delta = Math.abs(audioRef.current.currentTime - entry.position);
        if (delta > 0.5) {
          pendingSeekPositionRef.current = entry.position;
          pendingSeekAttemptsRef.current = 0;
          seekingToTargetRef.current = false;
          applyPendingSeek();
        }
      }
      currentTitleRef.current = entry.title;
      setNowPlayingTitle(entry.title ?? null);
      return;
    }

    loadFromHistory(entry, { forceReset: true });
  };

  const handleSeeked = () => {
    const audio = audioRef.current;
    const pending = pendingSeekPositionRef.current;

    seekingToTargetRef.current = false;

    if (!audio || pending === null) return;

    // Check if we've reached the target position
    if (Math.abs(audio.currentTime - pending) <= 0.5) {
      pendingSeekPositionRef.current = null;
      if (pendingSeekTimerRef.current) {
        clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
    } else {
      // Seek didn't land at target, retry
      schedulePendingSeekRetry();
    }
  };

  const handleLoadedMetadata = () => {
    const audio = audioRef.current;
    if (audio) {
      setDuration(audio.duration);
    }
    applyPendingSeek();
  };

  const handlePause = () => {
    setIsPlaying(false);
    pausedAtTimestampRef.current = Date.now();
    saveHistoryEntry();
  };

  const handleSeek = (value: number[]) => {
    const audio = audioRef.current;
    if (audio && isFinite(value[0])) {
      audio.currentTime = value[0];
      setCurrentTime(value[0]);
    }
  };

  const seekRelative = (seconds: number) => {
    const audio = audioRef.current;
    if (audio) {
      const newTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds));
      audio.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleVolumeChange = (value: number[]) => {
    const audio = audioRef.current;
    if (audio) {
      audio.volume = value[0];
      setVolume(value[0]);
    }
  };

  const jumpToLiveEdge = () => {
    if (!isLiveStream) return;

    const audio = audioRef.current;
    if (!audio) return;

    if (hlsRef.current) {
      hlsRef.current.startLoad();
    }

    if (audio.seekable.length > 0) {
      const liveEdge = audio.seekable.end(audio.seekable.length - 1);
      if (isFinite(liveEdge)) {
        audio.currentTime = liveEdge;
        setCurrentTime(liveEdge);
      }
    }

    audio.play().catch((e) => setError(`Playback error: ${e.message}`));
  };

  const handleHistorySelect = (entry: HistoryEntry) => {
    // Move selected entry to top immediately
    setHistory((prev) => {
      const updatedEntry: HistoryEntry = {
        ...entry,
        lastPlayedAt: new Date().toISOString(),
      };
      const newHistory = [updatedEntry, ...prev.filter((h) => h.url !== entry.url)];
      saveHistory(newHistory);
      return newHistory;
    });
    loadFromHistory(entry);
  };

  const startTitleEdit = (entry: HistoryEntry) => {
    setEditingUrl(entry.url);
    setEditingTitle(entry.title ?? "");
  };

  const cancelTitleEdit = () => {
    setEditingUrl(null);
    setEditingTitle("");
  };

  const saveTitleEdit = (entry: HistoryEntry, nextTitle: string) => {
    const normalized = normalizeTitle(nextTitle);
    setHistory((prev) => {
      const newHistory = prev.map((item) =>
        item.url === entry.url ? { ...item, title: normalized } : item
      );
      saveHistory(newHistory);
      return newHistory;
    });
    if (nowPlayingUrl === entry.url) {
      setNowPlayingTitle(normalized ?? null);
    }
    if (currentUrlRef.current === entry.url) {
      currentTitleRef.current = normalized;
    }
    cancelTitleEdit();
  };

  const startNowPlayingTitleEdit = () => {
    setIsEditingNowPlaying(true);
    setNowPlayingTitleDraft(nowPlayingTitle ?? "");
  };

  const cancelNowPlayingTitleEdit = () => {
    setIsEditingNowPlaying(false);
    setNowPlayingTitleDraft("");
  };

  const saveNowPlayingTitleEdit = (nextTitle: string) => {
    if (!nowPlayingUrl) return;
    const normalized = normalizeTitle(nextTitle);
    setHistory((prev) => {
      const existing = prev.find((entry) => entry.url === nowPlayingUrl);
      if (!existing) return prev;
      const newHistory = prev.map((entry) =>
        entry.url === nowPlayingUrl ? { ...entry, title: normalized } : entry
      );
      saveHistory(newHistory);
      return newHistory;
    });
    setNowPlayingTitle(normalized ?? null);
    if (currentUrlRef.current === nowPlayingUrl) {
      currentTitleRef.current = normalized;
    }
    cancelNowPlayingTitleEdit();
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

  // Cross-tab sync: reload history when tab becomes visible if it was updated elsewhere
  useEffect(() => {
    const handleVisibilityChange = () => {
      // Only check when tab becomes visible and audio is not playing
      if (document.visibilityState === "visible" && !isPlaying) {
        const pausedAt = pausedAtTimestampRef.current;
        if (pausedAt === null) return;

        // Get the localStorage history timestamp
        const storedTimestamp = localStorage.getItem(HISTORY_TIMESTAMP_KEY);
        if (!storedTimestamp) return;

        const historyUpdatedAt = parseInt(storedTimestamp, 10);

        // If history was updated after we paused, reload it
        if (historyUpdatedAt > pausedAt) {
          const freshHistory = getHistory();
          setHistory(freshHistory);

          // Load the most recent entry if available (paused state)
          if (freshHistory.length > 0) {
            loadFromHistory(freshHistory[0]);
          }
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isPlaying, loadFromHistory]);

  const showLiveCta = isLiveStream && !isPlaying;
  const handleSessionStatusChange = useCallback((status: "unclaimed" | "active" | "stale" | "unknown") => {
    setIsSessionStale(status === "stale");
    if (status === "stale") {
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        audio.pause();
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      // Clean up Web Audio API state so setupGainNode can run correctly after recovery
      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }
      if (gainNodeRef.current) {
        gainNodeRef.current.disconnect();
        gainNodeRef.current = null;
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch((err) => {
          console.error("Failed to close AudioContext:", err);
        });
        audioContextRef.current = null;
      }
      if (audio) {
        audio.src = "";
        audio.load();
      }
      setIsLoaded(false);
      setIsPlaying(false);
    }
  }, []);

  useEffect(() => {
    if (isSessionStale) {
      wasSessionStaleRef.current = true;
      return;
    }
    if (!wasSessionStaleRef.current) return;
    wasSessionStaleRef.current = false;
    const entry =
      (nowPlayingUrl && history.find((item) => item.url === nowPlayingUrl)) ||
      history[0];
    if (!entry) return;
    const timeoutId = window.setTimeout(() => {
      loadFromHistory(entry, { forceReset: true });
    }, 0);
    return () => {
      clearTimeout(timeoutId);
    };
  }, [isSessionStale, history, nowPlayingUrl, loadFromHistory]);

  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-6">
      {/* URL Input */}
      {nowPlayingUrl && !shouldShowLoadInputs ? (
        <Button
          variant="outline"
          onClick={() => setShowLoadInputs(true)}
          disabled={isSessionStale}
          className="w-full"
        >
          Load another
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <label className="text-sm font-medium">Title (optional)</label>
            <Input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a short title"
              disabled={isSessionStale}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Audio URL</label>
            <div className="flex gap-2">
              <Input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Enter audio URL"
                onKeyDown={(e) => e.key === "Enter" && !isSessionStale && loadStream()}
                disabled={isSessionStale}
              />
              <Button onClick={() => loadStream()} disabled={isSessionStale}>Load</Button>
              {nowPlayingUrl && (
                <Button
                  variant="ghost"
                  onClick={() => setShowLoadInputs(false)}
                  disabled={isSessionStale}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {isSessionStale ? (
        <div className="text-sm text-amber-700 bg-amber-500/10 border border-amber-500/20 p-3 rounded-md">
          Session taken over by another tab/device. Controls are disabled.
        </div>
      ) : (
        error && (
          <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
            {error}
          </div>
        )
      )}

      {/* Now Playing */}
      {nowPlayingUrl && (
        <div className="space-y-1">
          <label className="text-sm font-medium">Now Playing</label>
          <div className="space-y-1">
            {isEditingNowPlaying ? (
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={nowPlayingTitleDraft}
                  onChange={(e) => setNowPlayingTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveNowPlayingTitleEdit(nowPlayingTitleDraft);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelNowPlayingTitleEdit();
                    }
                  }}
                  placeholder="Add a title"
                  className="h-7 text-sm"
                  autoFocus
                  disabled={isSessionStale}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => saveNowPlayingTitleEdit(nowPlayingTitleDraft)}
                  disabled={isSessionStale}
                  className="h-7 px-2 text-xs"
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={cancelNowPlayingTitleEdit}
                  disabled={isSessionStale}
                  className="h-7 px-2 text-xs text-muted-foreground"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium truncate flex-1" title={nowPlayingTitle ?? ""}>
                  {nowPlayingTitle ?? "Untitled"}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={startNowPlayingTitleEdit}
                  disabled={isSessionStale}
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                  title="Edit title"
                >
                  <EditIcon className="w-4 h-4" />
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="text-sm text-muted-foreground truncate flex-1" title={nowPlayingUrl}>
                {nowPlayingUrl}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(nowPlayingUrl)}
                className={`h-6 w-6 p-0 shrink-0 ${copiedUrl === nowPlayingUrl ? "text-green-500" : "text-muted-foreground hover:text-foreground"}`}
                title={copiedUrl === nowPlayingUrl ? "Copied!" : "Copy URL"}
              >
                {copiedUrl === nowPlayingUrl ? <CheckIcon className="w-4 h-4" /> : <CopyIcon className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </div>
      )}

      {!isSessionStale && (
        <audio
          ref={audioRef}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onCanPlay={applyPendingSeek}
          onPlay={() => {
            setIsPlaying(true);
          }}
          onSeeked={handleSeeked}
          onPause={handlePause}
          onEnded={() => setIsPlaying(false)}
          onError={() => setError("Audio playback error")}
        />
      )}

      {!isSessionStale && (
        <div className="space-y-4">
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => seekRelative(-15)}
            disabled={!isLoaded || isLiveStream || isSessionStale}
            className="flex items-center justify-center h-12 w-12 rounded-full border border-border bg-card text-muted-foreground shadow-sm transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:border-dashed disabled:bg-muted/40 disabled:text-muted-foreground/70"
            title={isSessionStale ? "Take over session first" : isLiveStream ? "Seeking disabled for live" : "Back 15 seconds"}
          >
            <Skip15BackIcon className="w-10 h-10" />
          </button>
          <button
            onClick={togglePlayPause}
            disabled={!isLoaded || isSessionStale}
            className="flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 transition-transform"
          >
            {isPlaying ? (
              <PauseCircleIcon className="w-16 h-16" />
            ) : (
              <PlayCircleIcon className="w-16 h-16" />
            )}
          </button>
          <button
            onClick={() => seekRelative(30)}
            disabled={!isLoaded || isLiveStream || isSessionStale}
            className="flex items-center justify-center h-12 w-12 rounded-full border border-border bg-card text-muted-foreground shadow-sm transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:border-dashed disabled:bg-muted/40 disabled:text-muted-foreground/70"
            title={isSessionStale ? "Take over session first" : isLiveStream ? "Seeking disabled for live" : "Forward 30 seconds"}
          >
            <Skip30ForwardIcon className="w-10 h-10" />
          </button>
        </div>

        {isLiveStream ? (
          <div className="flex items-center gap-3 rounded-lg border border-red-100/80 bg-gradient-to-r from-red-50 to-background px-4 py-3">
            <div className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-70" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-600" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-red-100 bg-white/80 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-red-600 shadow-sm">
                  Live
                </span>
                <span className="text-xs text-muted-foreground">Live stream · seeking disabled</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                Stay near the live edge. If you paused or lagged, tap Go live to catch up.
              </p>
            </div>
            {showLiveCta && (
              <Button
                size="sm"
                variant="outline"
                onClick={jumpToLiveEdge}
                disabled={isSessionStale}
                className="border-red-200 text-red-700 hover:bg-red-50"
              >
                Go live
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <Slider
              value={[currentTime]}
              max={duration || 100}
              step={1}
              onValueChange={handleSeek}
              disabled={!isLoaded || !isFinite(duration) || isSessionStale}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <VolumeIcon className="w-4 h-4 text-muted-foreground" />
          <Slider
            value={[volume]}
            max={1}
            step={0.01}
            onValueChange={handleVolumeChange}
            disabled={isSessionStale}
            className="w-24"
          />
        </div>

        {/* Gain Control */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleGainToggle}
            disabled={!isLoaded || isSessionStale}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              gainEnabled
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:bg-accent"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
            title="Enable amplification beyond 100%"
          >
            Boost
          </button>
          {gainEnabled && (
            <>
              <Slider
                value={[gain]}
                min={1}
                max={3}
                step={0.1}
                onValueChange={(v) => setGain(v[0])}
                disabled={isSessionStale}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground w-12">
                {Math.round(gain * 100)}%
              </span>
            </>
          )}
        </div>
        </div>
      )}

      {isSessionStale && nowPlayingUrl && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          Now playing position: {formatTime(currentTime)}
        </div>
      )}

      {/* History List */}
      <div className="space-y-2">
        {history.length > 0 && (
          <>
            <button
              onClick={() => setHistoryExpanded(!historyExpanded)}
              className="flex items-center gap-2 text-sm font-medium hover:text-foreground/80"
            >
              <ChevronIcon className={`w-4 h-4 transition-transform ${historyExpanded ? "rotate-90" : ""}`} />
              History ({history.length})
            </button>
            {historyExpanded && (
              <>
                <div className="max-h-48 overflow-y-auto divide-y divide-border/60 border rounded-md">
                  {history.map((entry) => (
                    <div
                      key={entry.url}
                      onClick={() =>
                        !isSessionStale && editingUrl !== entry.url && handleHistorySelect(entry)
                      }
                      className={`flex items-start justify-between px-3 py-2 group ${
                        isSessionStale
                          ? "cursor-not-allowed opacity-60"
                          : "hover:bg-accent/60 cursor-pointer"
                      }`}
                    >
                      <div className="flex-1 min-w-0 mr-2">
                        {editingUrl === entry.url ? (
                          <>
                            <Input
                              type="text"
                              value={editingTitle}
                              onChange={(e) => setEditingTitle(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  saveTitleEdit(entry, editingTitle);
                                }
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  cancelTitleEdit();
                                }
                              }}
                              onBlur={() => saveTitleEdit(entry, editingTitle)}
                              placeholder="Add a title"
                              className="h-7 text-sm"
                              autoFocus
                              disabled={isSessionStale}
                            />
                            <div className="text-xs text-muted-foreground truncate" title={entry.url}>
                              {truncateUrl(entry.url)}
                            </div>
                          </>
                        ) : entry.title ? (
                          <>
                            <div className="text-sm font-medium truncate" title={entry.title}>
                              {entry.title}
                            </div>
                            <div className="text-xs text-muted-foreground truncate" title={entry.url}>
                              {truncateUrl(entry.url)}
                            </div>
                          </>
                        ) : (
                          <div className="text-sm truncate" title={entry.url}>
                            {truncateUrl(entry.url)}
                          </div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {formatDate(entry.lastPlayedAt)} &middot; {formatTime(entry.position)}
                        </div>
                      </div>
                      <div
                        className={`flex items-center gap-1 shrink-0 ${
                          entry.title || editingUrl === entry.url ? "mt-0.5" : ""
                        }`}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (editingUrl === entry.url) {
                              saveTitleEdit(entry, editingTitle);
                              return;
                            }
                            startTitleEdit(entry);
                          }}
                          onMouseDown={(e) => e.preventDefault()}
                          disabled={isSessionStale}
                          className={`h-6 w-6 p-0 ${editingUrl === entry.url ? "opacity-100 text-foreground" : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground"} disabled:cursor-not-allowed`}
                          title={editingUrl === entry.url ? "Save title" : "Edit title"}
                        >
                          {editingUrl === entry.url ? (
                            <CheckIcon className="w-4 h-4" />
                          ) : (
                            <EditIcon className="w-4 h-4" />
                          )}
                        </Button>
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
                          disabled={isSessionStale}
                          className="opacity-0 group-hover:opacity-100 h-6 w-6 p-0 text-muted-foreground hover:text-destructive disabled:cursor-not-allowed"
                          title="Delete"
                        >
                          <XIcon className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClearHistory}
                  disabled={isSessionStale}
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  Clear All
                </Button>
              </>
            )}
          </>
        )}
        <NostrSyncPanel
          history={history}
          onHistoryLoaded={(merged) => {
            setHistory(merged);
            saveHistory(merged);
          }}
          onSessionStatusChange={handleSessionStatusChange}
          onTakeOver={(remoteHistory) => {
            onRequestReset?.(remoteHistory.length > 0 ? remoteHistory[0] : null);
          }}
          onRemoteSync={handleRemoteSync}
          sessionId={sessionId}
          isPlayingRef={isPlayingRef}
        />
      </div>
    </div>
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

function EditIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.232 5.232a2.5 2.5 0 0 1 3.536 3.536L7 20.536 3 21l.464-4 11.768-11.768z"
      />
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

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
    </svg>
  );
}

function PlayCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <path
        d="M9.5 7.5v9l7-4.5-7-4.5z"
        fill="white"
      />
    </svg>
  );
}

function PauseCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="12" cy="12" r="11" fill="currentColor" />
      <rect x="8" y="7" width="3" height="10" rx="0.5" fill="white" />
      <rect x="13" y="7" width="3" height="10" rx="0.5" fill="white" />
    </svg>
  );
}

function Skip15BackIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="currentColor"
        d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"
      />
      <text
        x="12"
        y="14"
        fontSize="8"
        fontWeight="700"
        textAnchor="middle"
        fill="currentColor"
        dominantBaseline="middle"
      >
        15
      </text>
    </svg>
  );
}

function Skip30ForwardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="currentColor"
        d="M12 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"
      />
      <text
        x="12"
        y="14"
        fontSize="7"
        fontWeight="700"
        textAnchor="middle"
        fill="currentColor"
        dominantBaseline="middle"
      >
        30
      </text>
    </svg>
  );
}
