# HLS Audio Player

A web-based audio player with HLS streaming support, built with React, TypeScript, and Tailwind CSS.

## Features

- **HLS Streaming Support** - Play HLS streams (.m3u8) using hls.js
- **Playback Controls** - Play/pause, seek forward (+30s), seek backward (-15s)
- **Progress Bar** - Visual progress with seekable slider, displays time in HH:MM:SS format
- **Volume Control** - Adjustable volume slider
- **URL History** - Automatically saves played URLs to localStorage
  - Stores last played position for each URL
  - Resume playback from where you left off
  - Copy URL to clipboard
  - Delete individual entries or clear all
  - Collapsible history list
- **Position Persistence** - Saves playback position every 5 seconds
- **Now Playing** - Displays currently loaded stream URL

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS v4
- shadcn/ui components
- hls.js for HLS playback

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

1. Enter an HLS stream URL (.m3u8) in the input field
2. Click "Load" or press Enter to load the stream
3. Use the play button to start playback
4. Use -15s and +30s buttons to seek
5. Adjust volume with the volume slider
6. Click on history items to reload and resume from saved position

## Example HLS Streams

You can test with any public HLS audio stream URL ending in `.m3u8`.
