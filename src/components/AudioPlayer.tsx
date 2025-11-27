import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";

interface AudioPlayerProps {
  initialUrl?: string;
}

function formatTime(seconds: number): string {
  if (isNaN(seconds) || !isFinite(seconds)) return "00:00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function AudioPlayer({ initialUrl = "" }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [url, setUrl] = useState(initialUrl);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
      }
    };
  }, []);

  const loadStream = () => {
    if (!url.trim()) {
      setError("Please enter a URL");
      return;
    }

    setError(null);
    setIsLoaded(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);

    const audio = audioRef.current;
    if (!audio) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    if (url.includes(".m3u8")) {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;

        hls.loadSource(url);
        hls.attachMedia(audio);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setIsLoaded(true);
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            setError(`HLS Error: ${data.type} - ${data.details}`);
            setIsLoaded(false);
          }
        });
      } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        audio.src = url;
        setIsLoaded(true);
      } else {
        setError("HLS is not supported in this browser");
      }
    } else {
      audio.src = url;
      setIsLoaded(true);
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

  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-6">
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
          <Button onClick={loadStream}>Load</Button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
          {error}
        </div>
      )}

      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
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
