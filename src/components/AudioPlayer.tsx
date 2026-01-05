import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Hls from "hls.js";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { NostrSyncPanel } from "./NostrSyncPanel";
import {
  getTimestampStorageKey,
  MAX_HISTORY_ENTRIES,
  getHistory,
  saveHistory,
  type HistoryEntry,
} from "@/lib/history";
import { HlsAudioDecoder } from "@/lib/hls-audio-decoder";

const SAVE_INTERVAL_MS = 5000;

interface AudioPlayerProps {
  initialUrl?: string;
}

interface AudioPlayerInnerProps extends AudioPlayerProps {
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
  const [sessionId] = useState(() => crypto.randomUUID());

  return (
    <AudioPlayerInner
      initialUrl={initialUrl}
      sessionId={sessionId}
    />
  );
}

function AudioPlayerInner({
  initialUrl = "",
  sessionId,
}: AudioPlayerInnerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const saveIntervalRef = useRef<number | null>(null);
  const currentUrlRef = useRef<string>("");
  const currentTitleRef = useRef<string | undefined>(undefined);
  const isLiveStreamRef = useRef<boolean>(false);
  const isPlayingRef = useRef<boolean>(false);
  const isDecodedHlsRef = useRef<boolean>(false);
  const decodedTimeRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserNodeRef = useRef<AnalyserNode | null>(null);
  const meterRafRef = useRef<number | null>(null);
  const decoderRef = useRef<HlsAudioDecoder | null>(null);
  const gainRef = useRef<number>(1);
  const pausedAtTimestampRef = useRef<number | null>(null);
  const pendingSeekTimerRef = useRef<number | null>(null);
  const pendingSeekAttemptsRef = useRef<number>(0);
  const seekingToTargetRef = useRef<boolean>(false);
  const pendingSeekPositionRef = useRef<number | null>(null);
  const fingerprintRef = useRef<string | undefined>(undefined);

  const [url, setUrl] = useState(initialUrl);
  const [storageFingerprint, setStorageFingerprint] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [nowPlayingUrl, setNowPlayingUrl] = useState<string | null>(null);
  const [nowPlayingTitle, setNowPlayingTitle] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [isLiveStream, setIsLiveStream] = useState(false);
  const [gainEnabled, setGainEnabled] = useState(false);
  const [gain, setGain] = useState(1); // 1 = 100%
  const [meterLevel, setMeterLevel] = useState(0);
  const [showMeter, setShowMeter] = useState(false);
  const [isDecodedHls, setIsDecodedHls] = useState(false);
  const [isViewOnly, setIsViewOnly] = useState(false);
  const [actualSessionStatus, setActualSessionStatus] = useState<"idle" | "active" | "stale" | "invalid" | "unknown">("unknown");
  const [editingUrl, setEditingUrl] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [showLoadInputs, setShowLoadInputs] = useState(true);
  const shouldShowLoadInputs = !nowPlayingUrl || showLoadInputs;
  const [isEditingNowPlaying, setIsEditingNowPlaying] = useState(false);
  const [nowPlayingTitleDraft, setNowPlayingTitleDraft] = useState("");
  const wasViewOnlyRef = useRef(false);
  const pendingLoadRef = useRef<{ entry: HistoryEntry; options?: { forceReset?: boolean } } | null>(null);
  const pendingUrlLoadRef = useRef<string | null>(null);

  const isIOSSafari = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent;
    const isIOS =
      /iP(hone|od|ad)/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    return isIOS && isSafari;
  }, []);

  const shouldUseDecodedHls = useCallback((nextUrl: string) => {
    if (!isIOSSafari) return false;
    try {
      const parsed = new URL(nextUrl);
      const pathname = parsed.pathname.toLowerCase();
      if (pathname.endsWith(".m3u8")) return true;
      const format = parsed.searchParams.get("format");
      return format === "m3u8" || format === "hls";
    } catch {
      return false;
    }
  }, [isIOSSafari]);


  // Keep refs in sync with state for use in callbacks
  useEffect(() => {
    isLiveStreamRef.current = isLiveStream;
  }, [isLiveStream]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    isDecodedHlsRef.current = isDecodedHls;
  }, [isDecodedHls]);

  useEffect(() => {
    decodedTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    gainRef.current = gain;
  }, [gain]);

  useEffect(() => {
    fingerprintRef.current = storageFingerprint;
  }, [storageFingerprint]);

  // Load history when fingerprint changes (scoped storage)
  useEffect(() => {
    setHistory(getHistory(storageFingerprint));
  }, [storageFingerprint]);

  // Handle fingerprint change from NostrSyncPanel
  const handleFingerprintChange = useCallback((fingerprint: string | undefined) => {
    setStorageFingerprint(fingerprint);
  }, []);

  // Clear pause timestamp when playing starts
  useEffect(() => {
    if (isPlaying) {
      pausedAtTimestampRef.current = null;
    }
  }, [isPlaying]);

  const resumeAudioContext = useCallback(() => {
    const ctx = audioContextRef.current;
    if (!ctx || ctx.state !== "suspended") return;
    ctx.resume().catch((err) => {
      console.error("Failed to resume AudioContext:", err);
    });
  }, []);

  const ensureAudioContextNodes = useCallback(() => {
    if (audioContextRef.current?.state === "closed") {
      audioContextRef.current = null;
      sourceNodeRef.current = null;
      gainNodeRef.current = null;
      analyserNodeRef.current = null;
    }

    if (audioContextRef.current && gainNodeRef.current && analyserNodeRef.current) {
      return true;
    }

    const AudioContextClass =
      (window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);

    if (!AudioContextClass) {
      console.warn("Web Audio API not supported; boost unavailable");
      setError("Boost is not supported in this browser.");
      return false;
    }

    try {
      const ctx = new AudioContextClass();
      const gainNode = ctx.createGain();
      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 2048;

      gainNode.connect(analyserNode);
      analyserNode.connect(ctx.destination);

      audioContextRef.current = ctx;
      gainNodeRef.current = gainNode;
      analyserNodeRef.current = analyserNode;

      return true;
    } catch (err) {
      console.error("Failed to initialize Web Audio API:", err);
      setError("Boost is unavailable for this stream.");
      return false;
    }
  }, []);

  const ensureMediaElementSource = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return false;

    if (!ensureAudioContextNodes()) return false;

    if (sourceNodeRef.current) {
      return true;
    }

    try {
      const source = audioContextRef.current!.createMediaElementSource(audio);
      source.connect(gainNodeRef.current!);
      sourceNodeRef.current = source;
      return true;
    } catch (err) {
      console.error("Failed to connect media element source:", err);
      setError("Boost is unavailable for this stream.");
      return false;
    }
  }, [ensureAudioContextNodes]);

  const resumeAudioGraph = useCallback(() => {
    if (!ensureAudioContextNodes()) return;
    resumeAudioContext();
  }, [ensureAudioContextNodes, resumeAudioContext]);

  const startMeter = useCallback(() => {
    const analyser = analyserNodeRef.current;
    if (!analyser || meterRafRef.current !== null) return;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i += 1) {
        const centered = (data[i] - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      setMeterLevel(rms);
      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopMeter = useCallback(() => {
    if (meterRafRef.current !== null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    setMeterLevel(0);
  }, []);

  const stopDecodedPlayback = useCallback(() => {
    if (decoderRef.current) {
      decoderRef.current.stop();
      decoderRef.current = null;
    }
    stopMeter();
    setIsDecodedHls(false);
  }, [stopMeter]);

  const startDecodedPlayback = useCallback(async (urlToLoad: string, startPosition?: number) => {
    if (!ensureAudioContextNodes() || !gainNodeRef.current || !audioContextRef.current) {
      setError("Web Audio is unavailable for decoded playback.");
      return false;
    }

    stopDecodedPlayback();
    setIsDecodedHls(true);
    setIsLiveStream(false);
    isLiveStreamRef.current = false;

    const decoder = new HlsAudioDecoder(urlToLoad, audioContextRef.current, gainNodeRef.current, {
      onTime: (time) => {
        setCurrentTime(time);
      },
      onDuration: (nextDuration, live) => {
        setDuration(nextDuration);
        setIsLiveStream(live);
        isLiveStreamRef.current = live;
      },
      onState: (playing) => {
        setIsPlaying(playing);
        if (playing) {
          startMeter();
        } else {
          stopMeter();
        }
      },
      onEnded: () => {
        setIsPlaying(false);
        stopMeter();
      },
      onError: (message) => {
        setError(message);
        console.error("[decoded-hls]", message);
      },
    });

    decoderRef.current = decoder;

    try {
      await decoder.load();
      if (typeof startPosition === "number" && isFinite(startPosition)) {
        decoder.seek(startPosition);
      }
      setIsLoaded(true);
      return true;
    } catch (err) {
      const message = (err as Error).message;
      setError(`Failed to load HLS for decoded playback: ${message}`);
      console.error("[decoded-hls] load error:", err);
      stopDecodedPlayback();
      return false;
    }
  }, [ensureAudioContextNodes, startMeter, stopDecodedPlayback, stopMeter]);

  // Apply gain value when enabled
  useEffect(() => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = gainEnabled ? gain : 1;
    }
  }, [gain, gainEnabled]);

  // Handle gain toggle
  const handleGainToggle = useCallback(() => {
    if (gainEnabled) {
      setGainEnabled(false);
      if (gainNodeRef.current) {
        gainNodeRef.current.gain.value = 1;
      }
      return;
    }

    const canEnable = isDecodedHls ? ensureAudioContextNodes() : ensureMediaElementSource();
    if (!canEnable || !gainNodeRef.current) {
      return;
    }

    gainNodeRef.current.gain.value = gainRef.current;
    resumeAudioContext();
    setGainEnabled(true);
  }, [gainEnabled, isDecodedHls, ensureAudioContextNodes, ensureMediaElementSource, resumeAudioContext]);

  // Save history entry with an explicit position (skip for live streams)
  const saveHistoryEntry = useCallback((position?: number, options?: { allowLive?: boolean }) => {
    const audio = audioRef.current;
    if (!currentUrlRef.current) return;
    if (!audio && !isDecodedHlsRef.current) return;
    const resolvedPosition =
      position ??
      (isDecodedHlsRef.current ? decodedTimeRef.current : audio?.currentTime ?? 0);
    if (!isFinite(resolvedPosition)) return;
    if (isLiveStreamRef.current && !options?.allowLive) {
      return; // Don't save position for live streams unless explicitly allowed
    }

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

      saveHistory(newHistory, fingerprintRef.current);
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
      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }
      if (gainNodeRef.current) {
        gainNodeRef.current.disconnect();
        gainNodeRef.current = null;
      }
      if (analyserNodeRef.current) {
        analyserNodeRef.current.disconnect();
        analyserNodeRef.current = null;
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch((err) => {
          console.error("Failed to close AudioContext:", err);
        });
        audioContextRef.current = null;
      }
      stopMeter();
      if (pendingSeekTimerRef.current) {
        clearTimeout(pendingSeekTimerRef.current);
        pendingSeekTimerRef.current = null;
      }
      stopDecodedPlayback();
    };
  }, [saveHistoryEntry, stopMeter, stopDecodedPlayback]);

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
    const useDecoded = shouldUseDecodedHls(urlToLoad);
    const audio = audioRef.current;

    if (!useDecoded && !audio) {
      pendingLoadRef.current = { entry, options };
      setIsDecodedHls(false);
      return;
    }

    if (options?.forceReset && audio) {
      audio.pause();
      audio.src = "";
      audio.load();
    }

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (useDecoded) {
      stopDecodedPlayback();
      if (audio) {
        audio.pause();
        audio.src = "";
        audio.load();
      }
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

    if (useDecoded) {
      void startDecodedPlayback(urlToLoad, entry.position).then((success) => {
        if (success) {
          onLoadSuccess();
        }
      });
      return;
    }

    stopDecodedPlayback();
    if (!audio) return;
    audio.crossOrigin = "anonymous";

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
  }, [saveHistoryEntry, shouldUseDecodedHls, startDecodedPlayback, stopDecodedPlayback]);

  // Load a URL - redirects to loadFromHistory if URL exists in history
  const loadUrl = useCallback((urlToLoad: string) => {
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
          saveHistory(newHistory, fingerprintRef.current);
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

    const useDecoded = shouldUseDecodedHls(urlToLoad);
    const audio = audioRef.current;
    if (!useDecoded && !audio) {
      pendingUrlLoadRef.current = urlToLoad;
      setIsDecodedHls(false);
      return;
    }

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
      saveHistoryEntry(0, { allowLive: true });
    };

    if (useDecoded) {
      stopDecodedPlayback();
      if (audio) {
        audio.pause();
        audio.src = "";
        audio.load();
      }
      void startDecodedPlayback(urlToLoad, 0).then((success) => {
        if (success) {
          onLoadSuccess();
        }
      });
      return;
    }

    stopDecodedPlayback();
    if (!audio) return;
    audio.crossOrigin = "anonymous";

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
  }, [history, loadFromHistory, saveHistoryEntry, shouldUseDecodedHls, startDecodedPlayback, stopDecodedPlayback, title]);

  useEffect(() => {
    if (!pendingLoadRef.current) return;
    if (!audioRef.current) return;
    const pending = pendingLoadRef.current;
    pendingLoadRef.current = null;
    loadFromHistory(pending.entry, pending.options);
  }, [isDecodedHls, loadFromHistory]);

  useEffect(() => {
    if (!pendingUrlLoadRef.current) return;
    if (!audioRef.current) return;
    const pending = pendingUrlLoadRef.current;
    pendingUrlLoadRef.current = null;
    loadUrl(pending);
  }, [isDecodedHls, loadUrl]);

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
    if (isDecodedHls && decoderRef.current) {
      resumeAudioGraph();
      if (isPlaying) {
        decoderRef.current.pause();
      } else {
        decoderRef.current.play();
      }
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      if (ensureMediaElementSource()) {
        resumeAudioGraph();
      }
      audio.play().catch((e) => {
        setError(`Playback error: ${e.message}`);
      });
    }
  };

  const handleTimeUpdate = () => {
    if (isDecodedHls) return;
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
    if (isDecodedHls) return;
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

    if (isViewOnly) {
      currentUrlRef.current = entry.url;
      currentTitleRef.current = entry.title;
      setNowPlayingUrl(entry.url);
      setNowPlayingTitle(entry.title ?? null);
      setCurrentTime(isFinite(entry.position) ? entry.position : 0);
      return;
    }

    if (currentUrlRef.current && currentUrlRef.current === entry.url) {
      if (!isLiveStreamRef.current && isFinite(entry.position)) {
        if (isDecodedHls && decoderRef.current) {
          decoderRef.current.seek(entry.position);
          setCurrentTime(entry.position);
        } else if (audioRef.current) {
          const delta = Math.abs(audioRef.current.currentTime - entry.position);
          if (delta > 0.5) {
            pendingSeekPositionRef.current = entry.position;
            pendingSeekAttemptsRef.current = 0;
            seekingToTargetRef.current = false;
            applyPendingSeek();
          }
        }
      }
      currentTitleRef.current = entry.title;
      setNowPlayingTitle(entry.title ?? null);
      return;
    }

    loadFromHistory(entry, { forceReset: true });
  };

  const handleSeeked = () => {
    if (isDecodedHls) return;
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
    if (isDecodedHls) return;
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
    stopMeter();
  };

  const handleSeek = (value: number[]) => {
    if (!isFinite(value[0])) return;
    if (isDecodedHls && decoderRef.current) {
      decoderRef.current.seek(value[0]);
      setCurrentTime(value[0]);
      return;
    }
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = value[0];
      setCurrentTime(value[0]);
    }
  };

  const seekRelative = useCallback((seconds: number) => {
    if (isLiveStreamRef.current) return;
    if (isDecodedHls && decoderRef.current) {
      const newTime = Math.max(0, Math.min(duration || 0, currentTime + seconds));
      decoderRef.current.seek(newTime);
      setCurrentTime(newTime);
      return;
    }
    const audio = audioRef.current;
    if (audio) {
      const newTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds));
      audio.currentTime = newTime;
      setCurrentTime(newTime);
    }
  }, [currentTime, duration, isDecodedHls]);

  const jumpToLiveEdge = () => {
    if (!isLiveStream) return;
    if (isDecodedHls && decoderRef.current) {
      resumeAudioGraph();
      decoderRef.current.jumpToLiveEdge();
      decoderRef.current.play();
      return;
    }

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

    resumeAudioGraph();
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
      saveHistory(newHistory, fingerprintRef.current);
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
      saveHistory(newHistory, fingerprintRef.current);
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
      saveHistory(newHistory, fingerprintRef.current);
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
      saveHistory(newHistory, fingerprintRef.current);
      return newHistory;
    });
  };

  const handleClearHistory = () => {
    if (!confirm("Clear all history? This cannot be undone.")) return;
    setHistory([]);
    saveHistory([], fingerprintRef.current);
  };

  // Cross-tab sync: reload history when tab becomes visible if it was updated elsewhere
  useEffect(() => {
    const handleVisibilityChange = () => {
      // Only check when tab becomes visible and audio is not playing
      if (document.visibilityState === "visible" && !isPlaying) {
        const pausedAt = pausedAtTimestampRef.current;
        if (pausedAt === null) return;

        // Get the localStorage history timestamp (scoped by fingerprint)
        const timestampKey = getTimestampStorageKey(fingerprintRef.current);
        const storedTimestamp = localStorage.getItem(timestampKey);
        if (!storedTimestamp) return;

        const historyUpdatedAt = parseInt(storedTimestamp, 10);

        // If history was updated after we paused, reload it
        if (historyUpdatedAt > pausedAt) {
          const freshHistory = getHistory(fingerprintRef.current);
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

  // Media Session API for iOS/Android lock screen controls
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const session = navigator.mediaSession;

    // Set action handlers with custom seek offsets (-15s back, +30s forward)
    session.setActionHandler("play", () => {
      resumeAudioGraph();
      if (isDecodedHls && decoderRef.current) {
        decoderRef.current.play();
      } else {
        audioRef.current?.play();
      }
    });
    session.setActionHandler("pause", () => {
      if (isDecodedHls && decoderRef.current) {
        decoderRef.current.pause();
      } else {
        audioRef.current?.pause();
      }
    });
    session.setActionHandler("seekbackward", () => {
      seekRelative(-15);
    });
    session.setActionHandler("seekforward", () => {
      seekRelative(30);
    });
    // iOS hardware skip buttons (AirPods, CarPlay, lock screen) trigger these
    session.setActionHandler("previoustrack", () => {
      seekRelative(-15);
    });
    session.setActionHandler("nexttrack", () => {
      seekRelative(30);
    });

    return () => {
      session.setActionHandler("play", null);
      session.setActionHandler("pause", null);
      session.setActionHandler("seekbackward", null);
      session.setActionHandler("seekforward", null);
      session.setActionHandler("previoustrack", null);
      session.setActionHandler("nexttrack", null);
    };
  }, [isDecodedHls, resumeAudioGraph, seekRelative]);

  // Update Media Session metadata when now playing changes
  useEffect(() => {
    if (!("mediaSession" in navigator) || !nowPlayingUrl) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlayingTitle || nowPlayingUrl,
      artist: "Audio Player",
    });
  }, [nowPlayingUrl, nowPlayingTitle]);

  const showLiveCta = isLiveStream && !isPlaying;
  const handleSessionStatusChange = useCallback((status: "idle" | "active" | "stale" | "invalid" | "unknown") => {
    // View-only states: disable controls and unmount audio element
    // - unknown: no secret in URL, view-only until user starts or resumes a session
    // - idle: arrived with valid secret, view synced history (no resources to cleanup - just loaded)
    // - stale: another device took over, must cleanup resources before becoming view-only
    // - invalid: bad checksum on load, nothing ever loaded (no resources to cleanup)
    // Note: unknown, idle, and invalid can only be reached from states without active resources,
    // so cleanup is only needed for stale (the active→stale transition).
    setIsViewOnly(status === "stale" || status === "idle" || status === "invalid" || status === "unknown");
    setActualSessionStatus(status);
    if (status === "stale") {
      // Cleanup resources before transitioning to view-only mode
      const audio = audioRef.current;
      stopDecodedPlayback();
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
      if (analyserNodeRef.current) {
        analyserNodeRef.current.disconnect();
        analyserNodeRef.current = null;
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch((err) => {
          console.error("Failed to close AudioContext:", err);
        });
        audioContextRef.current = null;
      }
      stopMeter();
      if (audio) {
        audio.src = "";
        audio.load();
      }
      setIsLoaded(false);
      setIsPlaying(false);
    }
  }, [stopDecodedPlayback, stopMeter]);

  useEffect(() => {
    if (isViewOnly) {
      wasViewOnlyRef.current = true;
      return;
    }
    if (!wasViewOnlyRef.current) return;
    wasViewOnlyRef.current = false;
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
  }, [isViewOnly, history, nowPlayingUrl, loadFromHistory]);

  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-6">
      {/* URL Input */}
      {nowPlayingUrl && !shouldShowLoadInputs ? (
        <Button
          variant="outline"
          onClick={() => setShowLoadInputs(true)}
          disabled={isViewOnly}
          className="w-full"
        >
          Add URL
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
              disabled={isViewOnly}
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
                onKeyDown={(e) => e.key === "Enter" && !isViewOnly && loadStream()}
                disabled={isViewOnly}
              />
              <Button onClick={() => loadStream()} disabled={isViewOnly}>Load</Button>
              {nowPlayingUrl && (
                <Button
                  variant="ghost"
                  onClick={() => setShowLoadInputs(false)}
                  disabled={isViewOnly}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {actualSessionStatus === "unknown" ? (
        <div className="text-sm text-muted-foreground bg-muted/50 border border-border p-3 rounded-md">
          No active session. Start or resume a session to enable controls.
        </div>
      ) : actualSessionStatus === "stale" ? (
        <div className="text-sm text-amber-700 bg-amber-500/10 border border-amber-500/20 p-3 rounded-md">
          Another device is now active. Controls are disabled.
        </div>
      ) : actualSessionStatus === "idle" ? (
        <div className="text-sm text-blue-700 bg-blue-500/10 border border-blue-500/20 p-3 rounded-md">
          Viewing mode. Start a session to enable controls.
        </div>
      ) : actualSessionStatus === "invalid" ? (
        <div className="text-sm text-red-700 bg-red-500/10 border border-red-500/20 p-3 rounded-md">
          Invalid secret link. Check for typos or generate a new one.
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
                  disabled={isViewOnly}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => saveNowPlayingTitleEdit(nowPlayingTitleDraft)}
                  disabled={isViewOnly}
                  className="h-7 px-2 text-xs"
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={cancelNowPlayingTitleEdit}
                  disabled={isViewOnly}
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
                  disabled={isViewOnly}
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

      {!isViewOnly && !isDecodedHls && (
        <audio
          ref={audioRef}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onCanPlay={applyPendingSeek}
          onPlay={() => {
            if (ensureMediaElementSource()) {
              resumeAudioGraph();
            }
            startMeter();
            setIsPlaying(true);
          }}
          onSeeked={handleSeeked}
          onPause={handlePause}
          onEnded={() => {
            setIsPlaying(false);
            stopMeter();
          }}
          onError={() => {
            const audio = audioRef.current;
            const code = audio?.error?.code;
            const detail = audio?.error?.message ?? "Unknown error";
            console.error("[audio-element] error", { code, detail });
            setError(`Audio playback error: ${detail}`);
          }}
          playsInline
          crossOrigin="anonymous"
        />
      )}

      {!isViewOnly && (
        <div className="space-y-4">
        <div className="flex items-center justify-center gap-4">
          <button
            onClick={() => seekRelative(-15)}
            disabled={!isLoaded || isLiveStream || isViewOnly}
            className="flex items-center justify-center h-12 w-12 rounded-full border border-border bg-card text-muted-foreground shadow-sm transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:border-dashed disabled:bg-muted/40 disabled:text-muted-foreground/70"
            title={isViewOnly ? "Take over session first" : isLiveStream ? "Seeking disabled for live" : "Back 15 seconds"}
          >
            <Skip15BackIcon className="w-10 h-10" />
          </button>
          <button
            onClick={togglePlayPause}
            disabled={!isLoaded || isViewOnly}
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
            disabled={!isLoaded || isLiveStream || isViewOnly}
            className="flex items-center justify-center h-12 w-12 rounded-full border border-border bg-card text-muted-foreground shadow-sm transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:border-dashed disabled:bg-muted/40 disabled:text-muted-foreground/70"
            title={isViewOnly ? "Take over session first" : isLiveStream ? "Seeking disabled for live" : "Forward 30 seconds"}
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
                disabled={isViewOnly}
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
              disabled={!isLoaded || !isFinite(duration) || isViewOnly}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        )}

        {/* Gain Control */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleGainToggle}
            disabled={!isLoaded || isViewOnly}
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
                disabled={isViewOnly}
                className="w-24"
              />
              <span className="text-xs text-muted-foreground w-12">
                {Math.round(gain * 100)}%
              </span>
            </>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showMeter}
              onChange={(e) => setShowMeter(e.target.checked)}
              disabled={isViewOnly}
              className="h-3 w-3 accent-foreground"
            />
            Meter
          </label>
        </div>

        {showMeter && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Meter</span>
              <span>{Math.round(meterLevel * 100)}%</span>
            </div>
            <div className="h-2 rounded bg-muted overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-[width] duration-75"
                style={{ width: `${Math.min(100, Math.round(meterLevel * 100))}%` }}
              />
            </div>
          </div>
        )}
        </div>
      )}

      {isViewOnly && nowPlayingUrl && (
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
                        !isViewOnly && editingUrl !== entry.url && handleHistorySelect(entry)
                      }
                      className={`flex items-start justify-between px-3 py-2 group ${
                        isViewOnly
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
                              disabled={isViewOnly}
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
                          disabled={isViewOnly}
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
                          disabled={isViewOnly}
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
                  disabled={isViewOnly}
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
            saveHistory(merged, fingerprintRef.current);
          }}
          onSessionStatusChange={handleSessionStatusChange}
          onTakeOver={(remoteHistory) => {
            handleRemoteSync(remoteHistory);
          }}
          onRemoteSync={handleRemoteSync}
          onFingerprintChange={handleFingerprintChange}
          sessionId={sessionId}
          isPlayingRef={isPlayingRef}
        />
      </div>
    </div>
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
