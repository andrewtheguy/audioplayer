import { Parser } from "m3u8-parser";
import muxjs from "mux.js";

type Segment = {
  url: string;
  duration: number;
  start: number;
  sequence?: number;
};

type LoadResult = {
  duration: number;
  isLive: boolean;
};

type DecoderCallbacks = {
  onTime: (time: number) => void;
  onDuration: (duration: number, isLive: boolean) => void;
  onState: (playing: boolean) => void;
  onEnded: () => void;
  onError: (message: string) => void;
};

const BUFFER_AHEAD_SECONDS = 20;
const START_DELAY_SECONDS = 0.12;

function resolveUrl(base: string, relative: string): string {
  return new URL(relative, base).toString();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) {
    throw new Error(`Failed to load playlist (${res.status}): ${url}`);
  }
  return res.text();
}

function parsePlaylist(text: string, baseUrl: string): {
  isMaster: boolean;
  playlists: string[];
  segments: Segment[];
  isLive: boolean;
  mediaSequence: number;
  targetDuration: number;
} {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  const manifest = parser.manifest as {
    playlists?: Array<{ uri: string }>;
    segments?: Array<{ duration: number; uri: string }>;
    endList?: boolean;
    mediaSequence?: number;
    targetDuration?: number;
  };

  const playlists = ((manifest.playlists ?? []) as Array<{ uri: string }>).map((playlist) =>
    resolveUrl(baseUrl, playlist.uri)
  );
  const segments: Segment[] = [];
  let cursor = 0;
  const mediaSequence = typeof manifest.mediaSequence === "number" ? manifest.mediaSequence : 0;
  for (const segment of manifest.segments ?? []) {
    const duration = typeof segment.duration === "number" ? segment.duration : 0;
    const url = resolveUrl(baseUrl, segment.uri);
    segments.push({
      url,
      duration,
      start: cursor,
      sequence: mediaSequence + segments.length,
    });
    cursor += duration;
  }

  const isLive = manifest.endList !== true;
  return {
    isMaster: playlists.length > 0,
    playlists,
    segments,
    isLive,
    mediaSequence,
    targetDuration: typeof manifest.targetDuration === "number" ? manifest.targetDuration : 6,
  };
}

export class HlsAudioDecoder {
  private readonly url: string;
  private readonly ctx: AudioContext;
  private readonly outputNode: AudioNode;
  private readonly callbacks: DecoderCallbacks;
  private segments: Segment[] = [];
  private duration = 0;
  private isLive = false;
  private mode: "vod" | "live" = "vod";
  private isLoaded = false;
  private isPlaying = false;
  private startCtxTime = 0;
  private startMediaTime = 0;
  private scheduleCursor = 0;
  private currentTime = 0;
  private nextSegmentIndex = 0;
  private startSegmentIndex = 0;
  private scheduleToken = 0;
  private playlistUrl: string | null = null;
  private targetDuration = 6;
  private liveQueue: Segment[] = [];
  private pollTimer: number | null = null;
  private lastSequenceSeen: number | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private timeRaf: number | null = null;
  private scheduling = false;
  private stopped = false;

  constructor(url: string, ctx: AudioContext, outputNode: AudioNode, callbacks: DecoderCallbacks) {
    this.url = url;
    this.ctx = ctx;
    this.outputNode = outputNode;
    this.callbacks = callbacks;
  }

  async load(): Promise<LoadResult> {
    const playlistText = await fetchText(this.url);
    const baseUrl = new URL(this.url).toString();
    const parsed = parsePlaylist(playlistText, baseUrl);

    if (parsed.isMaster) {
      if (parsed.playlists.length === 0) {
        throw new Error("HLS master playlist has no variants.");
      }
      const mediaUrl = parsed.playlists[0];
      const mediaText = await fetchText(mediaUrl);
      const mediaParsed = parsePlaylist(mediaText, mediaUrl);
      this.segments = mediaParsed.segments;
      this.isLive = mediaParsed.isLive;
      this.playlistUrl = mediaUrl;
      this.targetDuration = mediaParsed.targetDuration;
    } else {
      this.segments = parsed.segments;
      this.isLive = parsed.isLive;
      this.playlistUrl = this.url;
      this.targetDuration = parsed.targetDuration;
    }

    if (this.segments.length === 0) {
      throw new Error("HLS playlist has no audio segments.");
    }

    this.mode = this.isLive ? "live" : "vod";
    this.duration = this.isLive ? 0 : this.segments.reduce((sum, segment) => sum + segment.duration, 0);
    this.isLoaded = true;
    this.callbacks.onDuration(this.duration, this.isLive);

    if (this.isLive) {
      await this.refreshLivePlaylist(true);
    }
    return { duration: this.duration, isLive: this.isLive };
  }

  getCurrentTime(): number {
    return this.currentTime;
  }

  play(): void {
    if (!this.isLoaded || this.isPlaying) return;
    this.isPlaying = true;
    this.callbacks.onState(true);
    if (this.mode === "live") {
      this.startLivePlayback();
    } else {
      this.startScheduling(this.currentTime);
    }
    this.startClock();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.currentTime = this.computeCurrentTime();
    this.isPlaying = false;
    this.callbacks.onState(false);
    this.scheduleToken += 1;
    this.stopLivePolling();
    this.stopSources();
    this.stopClock();
  }

  seek(time: number): void {
    if (!this.isLoaded) return;
    if (this.mode === "live") {
      return;
    }
    const nextTime = Math.max(0, Math.min(this.duration, time));
    this.currentTime = nextTime;
    if (!this.isPlaying) {
      this.callbacks.onTime(this.currentTime);
      return;
    }
    this.scheduleToken += 1;
    this.stopSources();
    this.scheduling = false;
    this.startScheduling(this.currentTime);
  }

  jumpToLiveEdge(): void {
    if (this.mode !== "live") return;
    this.scheduleToken += 1;
    this.stopSources();
    this.scheduling = false;
    this.startLivePlayback();
  }

  stop(): void {
    this.isPlaying = false;
    this.stopped = true;
    this.scheduleToken += 1;
    this.stopLivePolling();
    this.stopSources();
    this.stopClock();
  }

  private startScheduling(startTime: number): void {
    if (this.scheduling || this.stopped) return;
    this.scheduleToken += 1;
    const index = this.findSegmentIndex(startTime);
    this.nextSegmentIndex = index;
    this.startSegmentIndex = index;
    this.startMediaTime = startTime;
    this.currentTime = startTime;
    this.startCtxTime = this.ctx.currentTime + START_DELAY_SECONDS;
    this.scheduleCursor = this.startCtxTime;
    void this.scheduleLoop(this.scheduleToken, startTime - this.segments[index].start);
  }

  private startLivePlayback(): void {
    if (this.scheduling || this.stopped) return;
    this.scheduleToken += 1;
    this.startMediaTime = 0;
    this.currentTime = 0;
    this.startCtxTime = this.ctx.currentTime + START_DELAY_SECONDS;
    this.scheduleCursor = this.startCtxTime;
    this.startLivePolling();
    void this.scheduleLiveLoop(this.scheduleToken);
  }

  private async scheduleLoop(token: number, initialOffset: number): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;

    try {
      let offset = initialOffset;
      while (this.isPlaying && !this.stopped && this.nextSegmentIndex < this.segments.length) {
        if (token !== this.scheduleToken) {
          break;
        }
        if (this.scheduleCursor - this.ctx.currentTime > BUFFER_AHEAD_SECONDS) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }

        const segment = this.segments[this.nextSegmentIndex];
        let buffer: AudioBuffer;
        try {
      buffer = await this.decodeSegment(segment.url);
    } catch (err) {
      this.callbacks.onError(`Failed to decode segment: ${segment.url} (${(err as Error).message})`);
      this.pause();
      break;
    }

        if (!this.isPlaying || token !== this.scheduleToken) break;

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.outputNode);

        const segmentOffset = this.nextSegmentIndex === this.startSegmentIndex ? offset : 0;
        const playDuration = Math.max(0, buffer.duration - segmentOffset);
        if (playDuration <= 0.01) {
          this.nextSegmentIndex += 1;
          continue;
        }

        const startTime = Math.max(this.scheduleCursor, this.ctx.currentTime + 0.02);
        if (this.nextSegmentIndex === this.segments.length - 1) {
          source.onended = () => {
            if (token !== this.scheduleToken) return;
            if (!this.isPlaying) return;
            this.isPlaying = false;
            this.callbacks.onState(false);
            this.callbacks.onEnded();
          };
        }
        source.start(startTime, segmentOffset);
        this.sources.push(source);
        this.scheduleCursor = startTime + playDuration;
        this.nextSegmentIndex += 1;
        offset = 0;
      }

      // End-of-playback is handled by the onended handler for the final source.
    } finally {
      this.scheduling = false;
    }
  }

  private async scheduleLiveLoop(token: number): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;

    try {
      while (this.isPlaying && !this.stopped) {
        if (token !== this.scheduleToken) {
          break;
        }
        if (this.scheduleCursor - this.ctx.currentTime > BUFFER_AHEAD_SECONDS) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        const segment = this.liveQueue.shift();
        if (!segment) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }

        let buffer: AudioBuffer;
        try {
          buffer = await this.decodeSegment(segment.url);
        } catch (err) {
          this.callbacks.onError(`Failed to decode segment: ${segment.url} (${(err as Error).message})`);
          this.pause();
          break;
        }

        if (!this.isPlaying || token !== this.scheduleToken) break;

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.outputNode);

        const startTime = Math.max(this.scheduleCursor, this.ctx.currentTime + 0.02);
        source.start(startTime);
        this.sources.push(source);
        this.scheduleCursor = startTime + buffer.duration;
      }
    } finally {
      this.scheduling = false;
    }
  }

  private startLivePolling(): void {
    if (!this.playlistUrl) return;
    if (this.pollTimer !== null) return;
    const intervalMs = Math.max(2000, Math.floor(this.targetDuration * 500));
    this.pollTimer = window.setInterval(() => {
      void this.refreshLivePlaylist(false);
    }, intervalMs);
  }

  private stopLivePolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async refreshLivePlaylist(initial: boolean): Promise<void> {
    if (!this.playlistUrl) return;
    let text: string;
    try {
      text = await fetchText(this.playlistUrl);
    } catch (err) {
      if (initial) {
        throw err;
      }
      return;
    }
    const parsed = parsePlaylist(text, this.playlistUrl);
    if (!parsed.isLive) {
      this.isLive = false;
      this.mode = "vod";
      return;
    }

    const segments = parsed.segments;
    if (segments.length === 0) return;

    const lastSegment = segments[segments.length - 1];
    const lastSequence = typeof lastSegment.sequence === "number" ? lastSegment.sequence : null;

    if (initial || this.lastSequenceSeen === null) {
      const startIndex = Math.max(0, segments.length - 3);
      this.liveQueue = segments.slice(startIndex);
      this.lastSequenceSeen = lastSequence;
      return;
    }

    const newSegments = segments.filter((seg) => {
      if (typeof seg.sequence !== "number") return false;
      return this.lastSequenceSeen === null || seg.sequence > this.lastSequenceSeen;
    });
    if (newSegments.length > 0) {
      this.liveQueue.push(...newSegments);
      this.lastSequenceSeen = lastSequence;
    }
  }

  private findSegmentIndex(time: number): number {
    for (let i = 0; i < this.segments.length; i += 1) {
      const segment = this.segments[i];
      if (time >= segment.start && time < segment.start + segment.duration) {
        return i;
      }
    }
    return this.segments.length - 1;
  }

  private computeCurrentTime(): number {
    if (!this.isPlaying) return this.currentTime;
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    return Math.max(0, Math.min(this.duration, this.startMediaTime + elapsed));
  }

  private startClock(): void {
    if (this.timeRaf !== null) return;
    const tick = () => {
      if (!this.isPlaying) {
        this.timeRaf = null;
        return;
      }
      this.currentTime = this.computeCurrentTime();
      this.callbacks.onTime(this.currentTime);
      this.timeRaf = requestAnimationFrame(tick);
    };
    this.timeRaf = requestAnimationFrame(tick);
  }

  private stopClock(): void {
    if (this.timeRaf !== null) {
      cancelAnimationFrame(this.timeRaf);
      this.timeRaf = null;
    }
  }

  private stopSources(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // ignore
      }
      source.disconnect();
    }
    this.sources = [];
  }

  private async decodeSegment(url: string): Promise<AudioBuffer> {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) {
      throw new Error(`Segment fetch failed (${res.status})`);
    }
    let data: Uint8Array;
    try {
      data = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      throw new Error(`Segment buffer failed: ${(err as Error).message}`);
    }

    const mux = muxjs as { mp4: { Transmuxer: new (opts: { keepOriginalTimestamps: boolean }) => {
      on: (event: string, handler: (data: unknown) => void) => void;
      off?: (event: string, handler: (data: unknown) => void) => void;
      push: (data: Uint8Array) => void;
      flush: () => void;
    } } };
    const transmuxer = new mux.mp4.Transmuxer({ keepOriginalTimestamps: true });
    const segments: Uint8Array[] = [];
    let initSegment: Uint8Array | null = null;
    let transmuxErrorMessage: string | null = null;

    const handleData = (segment: unknown) => {
      const payload = segment as { initSegment?: Uint8Array; data?: Uint8Array };
      if (!payload.initSegment || !payload.data) {
        return;
      }
      if (!initSegment) {
        initSegment = payload.initSegment;
      }
      segments.push(payload.data);
    };
    const handleError = (err: unknown) => {
      transmuxErrorMessage = err instanceof Error ? err.message : String(err);
    };

    transmuxer.on("data", handleData);
    transmuxer.on("error", handleError);

    transmuxer.push(data);
    transmuxer.flush();

    if (transmuxer.off) {
      transmuxer.off("data", handleData);
      transmuxer.off("error", handleError);
    }

    if (transmuxErrorMessage !== null) {
      throw new Error(`Transmuxer error: ${transmuxErrorMessage}`);
    }

    if (!initSegment || segments.length === 0) {
      throw new Error("Transmuxer produced no audio data.");
    }

    const init = initSegment as Uint8Array;
    const totalLength = init.byteLength + segments.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    combined.set(init, offset);
    offset += init.byteLength;
    for (const chunk of segments) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.ctx.decodeAudioData(combined.buffer.slice(0));
    } catch (err) {
      throw new Error(`decodeAudioData failed: ${(err as Error).message}`);
    }
    return audioBuffer;
  }
}
