import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HlsAudioDecoder } from "./hls-audio-decoder";

type MockSource = {
  buffer: AudioBuffer | null;
  onended: (() => void) | null;
  connect: (node: unknown) => void;
  disconnect: () => void;
  start: (when?: number, offset?: number) => void;
  stop: () => void;
  disconnectCalled: boolean;
};

class MockAudioContext {
  currentTime = 0;
  private durations: number[];

  constructor(durations: number[] = [10]) {
    this.durations = durations;
  }

  createBufferSource(): MockSource {
    return {
      buffer: null,
      onended: null,
      connect: () => {},
      disconnect: function () {
        this.disconnectCalled = true;
      },
      start: () => {},
      stop: () => {},
      disconnectCalled: false,
    };
  }

  async decodeAudioData(): Promise<AudioBuffer> {
    const duration = this.durations.length > 0 ? this.durations.shift()! : 10;
    return { duration } as AudioBuffer;
  }
}

const buildMasterPlaylist = (mediaUri: string) => [
  "#EXTM3U",
  "#EXT-X-VERSION:2",
  '#EXT-X-STREAM-INF:BANDWIDTH=70400,CODECS="mp4a.40.2"',
  mediaUri,
  "",
].join("\n");

const buildMediaPlaylist = (
  segments: Array<{ uri: string; duration: number }>,
  endList = false,
  mediaSequence = 0
) => [
  "#EXTM3U",
  "#EXT-X-VERSION:2",
  "#EXT-X-TARGETDURATION:10",
  `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
  ...segments.flatMap((segment) => [`#EXTINF:${segment.duration.toFixed(3)},`, segment.uri]),
  endList ? "#EXT-X-ENDLIST" : "",
].join("\n");

vi.mock("mux.js", () => {
  class Transmuxer {
    private handlers: Record<string, (data: unknown) => void> = {};
    on(event: string, handler: (data: unknown) => void) {
      this.handlers[event] = handler;
    }
    off(event: string) {
      delete this.handlers[event];
    }
    push() {}
    flush() {
      const initSegment = new Uint8Array([0, 1, 2]);
      const data = new Uint8Array([3, 4, 5]);
      this.handlers.data?.({ initSegment, data });
    }
  }
  return {
    default: {
      mp4: {
        Transmuxer,
      },
    },
  };
});

describe("HlsAudioDecoder", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalRAF: typeof globalThis.requestAnimationFrame;
  let originalCAF: typeof globalThis.cancelAnimationFrame;

  beforeEach(() => {
    vi.useRealTimers();
    originalFetch = globalThis.fetch;
    originalRAF = globalThis.requestAnimationFrame;
    originalCAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
    globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    vi.restoreAllMocks();
  });

  it("trims live queue to 60s on initial load", async () => {
    const masterUrl = "https://example.com/master.m3u8";
    const segments = Array.from({ length: 10 }, (_, i) => ({
      uri: `seg${i}.ts`,
      duration: 10,
    }));

    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = url.toString();
      if (value.endsWith("master.m3u8")) {
        return new Response(buildMasterPlaylist("index.m3u8"), { status: 200 });
      }
      if (value.endsWith("index.m3u8")) {
        return new Response(buildMediaPlaylist(segments, false), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    const ctx = new MockAudioContext();
    const outputNode = {};
    const decoder = new HlsAudioDecoder(masterUrl, ctx as unknown as AudioContext, outputNode as AudioNode, {
      onTime: () => {},
      onDuration: () => {},
      onState: () => {},
      onEnded: () => {},
      onError: () => {},
    });

    await decoder.load();
    const queue = (decoder as unknown as { liveQueue: Array<{ duration: number }> }).liveQueue;
    const total = queue.reduce((sum, seg) => sum + seg.duration, 0);
    expect(total).toBeLessThanOrEqual(60);
    expect(queue.length).toBe(6);
  });

  it("drops older live segments when new ones exceed cap", async () => {
    const mediaUrl = "https://example.com/index.m3u8";
    const initialSegments = Array.from({ length: 6 }, (_, i) => ({
      uri: `seg${i}.ts`,
      duration: 10,
    }));
    const nextSegments = Array.from({ length: 10 }, (_, i) => ({
      uri: `seg${i + 6}.ts`,
      duration: 10,
    }));

    let playlistCalls = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = url.toString();
      if (value.endsWith("index.m3u8")) {
        playlistCalls += 1;
        const playlist = playlistCalls <= 2
          ? buildMediaPlaylist(initialSegments, false, 0)
          : buildMediaPlaylist(nextSegments, false, 6);
        return new Response(playlist, { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    const ctx = new MockAudioContext();
    const decoder = new HlsAudioDecoder(mediaUrl, ctx as unknown as AudioContext, {} as AudioNode, {
      onTime: () => {},
      onDuration: () => {},
      onState: () => {},
      onEnded: () => {},
      onError: () => {},
    });

    await decoder.load();
    await (decoder as unknown as { refreshLivePlaylist: (initial: boolean) => Promise<void> }).refreshLivePlaylist(false);

    const queue = (decoder as unknown as { liveQueue: Array<{ url: string }> }).liveQueue;
    expect(queue.length).toBe(6);
    expect(queue[0].url).toContain("seg10.ts");
  });

  it("fires onEnded only after final source ends", async () => {
    const vodUrl = "https://example.com/vod.m3u8";
    const segments = [{ uri: "seg0.ts", duration: 5 }];

    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = url.toString();
      if (value.endsWith(".m3u8")) {
        return new Response(buildMediaPlaylist(segments, true), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    const ctx = new MockAudioContext([5]);
    const onEnded = vi.fn();
    const onState = vi.fn();
    const decoder = new HlsAudioDecoder(vodUrl, ctx as unknown as AudioContext, {} as AudioNode, {
      onTime: () => {},
      onDuration: () => {},
      onState,
      onEnded,
      onError: () => {},
    });

    await decoder.load();
    decoder.play();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onEnded).not.toHaveBeenCalled();
    const sources = (decoder as unknown as { sources: MockSource[] }).sources;
    expect(sources.length).toBe(1);
    sources[0].onended?.();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(false);
  });

  it("removes finished sources on ended", async () => {
    const vodUrl = "https://example.com/vod.m3u8";
    const segments = [{ uri: "seg0.ts", duration: 5 }];

    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const value = url.toString();
      if (value.endsWith(".m3u8")) {
        return new Response(buildMediaPlaylist(segments, true), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock;

    const ctx = new MockAudioContext([5]);
    const decoder = new HlsAudioDecoder(vodUrl, ctx as unknown as AudioContext, {} as AudioNode, {
      onTime: () => {},
      onDuration: () => {},
      onState: () => {},
      onEnded: () => {},
      onError: () => {},
    });

    await decoder.load();
    decoder.play();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const sources = (decoder as unknown as { sources: MockSource[] }).sources;
    expect(sources.length).toBe(1);
    const source = sources[0];
    source.onended?.();
    expect((decoder as unknown as { sources: MockSource[] }).sources.length).toBe(0);
    expect(source.disconnectCalled).toBe(true);
  });
});
