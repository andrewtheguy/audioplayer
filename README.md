# Audio Player

A web-based audio player supporting standard audio formats and HLS streaming, built with React, TypeScript, and Tailwind CSS.

## Features

- **Audio Playback** - Play standard audio URLs (MP3, etc.) and HLS streams (.m3u8)
- **Playback Controls** - Play/pause, seek forward (+30s), seek backward (-15s), with iOS/Android lock screen integration via Media Session API
- **Progress Bar** - Visual progress with seekable slider, displays time in HH:MM:SS format
- **Volume Control** - Adjustable volume slider
- **URL History** - Automatically saves played URLs to localStorage
  - Stores last played position for each URL
  - Resume playback from where you left off
  - Copy URL to clipboard
  - Delete individual entries or clear all
  - Collapsible history list
  - History is scoped by npub identity (different npubs = isolated histories)
- **Position Persistence** - Saves playback position every 5 seconds while playing (non-live streams)
- **Now Playing** - Displays currently loaded stream URL
- **Cross-Device Sync** - Sync playback history via Nostr protocol
  - End-to-end encrypted history storage using player ID derived keys
  - npub-based identity with shareable URLs
  - Per-device secondary secret for player ID encryption
  - Session ownership with explicit takeovers (active sessions become stale when another device claims the session)
  - Auto-save with debouncing

## Identity & Security Model

The application uses a layered key architecture:

1. **npub (public)** - Nostr public key in the URL path (`/:npub`), safe to share
2. **Secondary Secret (per-device)** - User-entered secret stored in localStorage, encrypts the player ID
3. **Player ID (on relay)** - Encrypted with secondary secret, signed by nsec, used to derive history encryption keys
4. **nsec (private)** - Only needed for initial setup and player ID rotation

**Security characteristics:**
- The npub URL is shareable - it only identifies the user, not their data
- Secondary secret must be transferred manually between devices (not in URL)
- History is encrypted with keys derived from player ID (NIP-44 encryption)
- Player ID rotation generates new keys; old history becomes inaccessible unless you migrate it (Settings can migrate by default)
- Encryption prevents casual snooping on Nostr relays

**Limitations:**
- This is not a high-security application - the playlist history is considered disposable
- XSS attacks on the same origin could potentially use stored keys
- Do not store sensitive information in playlist entries

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
