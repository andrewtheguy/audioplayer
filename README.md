# Audio Player

A web-based audio player supporting standard audio formats and HLS streaming, built with React, TypeScript, and Tailwind CSS.

## Features

- **Audio Playback** - Play standard audio URLs (MP3, etc.) and HLS streams (.m3u8)
- **Playback Controls** - Play/pause, seek forward (+30s), seek backward (-15s)
- **Progress Bar** - Visual progress with seekable slider, displays time in HH:MM:SS format
- **Volume Control** - Adjustable volume slider
- **URL History** - Automatically saves played URLs to localStorage
  - Stores last played position for each URL
  - Resume playback from where you left off
  - Copy URL to clipboard
  - Delete individual entries or clear all
  - Collapsible history list
  - History is scoped by session secret (different secrets = isolated histories)
- **Position Persistence** - Saves playback position every 5 seconds while playing (non-live streams)
- **Now Playing** - Displays currently loaded stream URL
- **Cross-Device Sync** - Sync playback history via Nostr protocol
  - End-to-end encrypted history storage
  - Session ownership with explicit takeovers (active sessions become stale when another device claims the session)
  - Auto-save with debouncing

## Security Note

Security is not a priority for this application. The playlist history is expected to be disposable and essentially public when the shareable playlist URL (the one you copy/share that contains the `#` fragment) is shared. The "secret" is the playlist identifier/access token stored in the URL fragment. The fragment is kept client-side and is not sent to relays or servers in HTTP requests; Nostr keys and relay URLs are separate and are not stored in the fragment. If someone gets the shareable URL, they can see or modify only the playlist audio URLs and playback positions—do not store anything sensitive in this app.

The encryption exists primarily to prevent casual snooping on Nostr relays, not to protect sensitive data. Do not use this application to store or sync anything confidential.

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- shadcn/ui components
- hls.js for HLS playback
- nostr-tools for cross-device sync

## Getting Started

### Install dependencies

```bash
npm install
```

### Run development server

```bash
npm run dev
```

### Build for production

```bash
npm run build
```

### Preview production build

```bash
npm run preview
```

## Usage

1. Enter an audio URL (MP3, HLS .m3u8, etc.) in the input field
2. Click "Load" or press Enter to load the stream
3. Use the play button to start playback
4. Use -15s and +30s buttons to seek
5. Adjust volume with the volume slider
6. Click on history items to reload and resume from saved position

## Example Audio URLs

You can test with any public audio URL (MP3, WAV, etc.) or HLS stream (.m3u8).
