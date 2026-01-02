# Audio Player Architecture

## Overview

This is an HLS audio player built with React and TypeScript that supports cross-device synchronization via the Nostr protocol. The application allows users to play HLS streams, track playback history, and sync their listening position across multiple devices using encrypted Nostr events.

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite
- **Styling**: Tailwind CSS, shadcn/ui components
- **HLS Playback**: hls.js
- **Sync Protocol**: Nostr (nostr-tools)
- **Encryption**: NIP-44 (for encrypted payloads)

## Directory Structure

```
src/
├── main.tsx                 # Application entry point
├── App.tsx                  # Root component
├── components/
│   ├── AudioPlayer.tsx      # Main audio player component
│   ├── NostrSyncPanel.tsx   # Nostr sync UI and logic
│   └── ui/                  # shadcn/ui components (button, slider, input)
└── lib/
    ├── history.ts           # Local history persistence (localStorage)
    ├── nostr-sync.ts        # Nostr relay communication
    ├── nostr-crypto.ts      # Key derivation and encryption
    └── utils.ts             # Utility functions (cn)
```

## Core Components

### AudioPlayer (`components/AudioPlayer.tsx`)

The main player component with two layers:

1. **AudioPlayer (outer)**: Manages component reset state and takeover entry
2. **AudioPlayerInner**: Contains all playback logic

Key features:
- HLS stream loading via hls.js
- Live stream detection (disables seeking for live content)
- Playback position tracking and restoration
- Pending seek mechanism with retry logic for reliable position sync
- Web Audio API gain control for volume boost beyond 100%
- History management with auto-save every 5 seconds

### NostrSyncPanel (`components/NostrSyncPanel.tsx`)

Handles cross-device synchronization:

- **Session Management**: Tracks active/stale session status
- **Auto-save**: Debounced saves when history changes (5s delay)
- **Takeover Logic**: Allows claiming a session from another device
- **Real-time Updates**: Subscribes to Nostr events for session changes

## Data Flow

### Local History Flow

```
User Action → AudioPlayer → saveCurrentPosition() → localStorage
                                    ↓
                              history state update
```

### Nostr Sync Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  AudioPlayer    │────▶│  NostrSyncPanel  │────▶│ Nostr Relays│
│  (history state)│◀────│  (sync logic)    │◀────│ (storage)   │
└─────────────────┘     └──────────────────┘     └─────────────┘
         │                       │
         ▼                       ▼
   localStorage            URL hash (secret)
```

### Session Takeover Flow

```
1. Device B clicks "Take Over Session"
2. NostrSyncPanel.performLoad(secret, isTakeOver=true)
3. Fetches and decrypts cloud history
4. Calls onTakeOver(cloudHistory)
5. AudioPlayer.handleRequestReset(entry)
6. Sets takeoverEntry + increments resetKey (remounts AudioPlayerInner)
7. AudioPlayerInner loads entry with forceReset
8. Pending seek mechanism restores playback position
```

## Library Modules

### history.ts

Local persistence layer using localStorage.

```typescript
interface HistoryEntry {
  url: string;          // Stream URL
  lastPlayedAt: string; // ISO timestamp
  position: number;     // Playback position in seconds
  gain?: number;        // Optional volume boost level
}
```

- `getHistory()`: Retrieves validated history from localStorage
- `saveHistory()`: Persists history with timestamp for cross-tab sync
- Max 100 entries (trimmed on save)

### nostr-sync.ts

Nostr protocol integration for cloud sync.

**Relays used:**
- wss://relay.damus.io
- wss://relay.primal.net
- wss://relay.nostr.band
- wss://nos.lol

**Event structure (NIP-78):**
- Kind: 30078 (application-specific replaceable)
- d-tag: "audioplayer-history"

**Session tag strategy**
- ✅ **Current:** UUIDv4 generated via `crypto.randomUUID()` per client session.

**Roadmap improvements**
- Namespaced, high-entropy IDs (UUIDv4 is acceptable).
- Publish-time collision checks: if an existing event contains the same session tag, regenerate and republish.
- Optional per-URL or per-user namespace prefix to avoid cross-URL collisions.

**Stale-session detection (roadmap)**
- Emit a heartbeat every 30s.
- Mark sessions inactive after 2 minutes without heartbeat.
- Periodic reconciler every 30–60s that prefers active sessions.
- Takeover requires explicit user confirmation if a different active session is detected.
- All intervals/timeouts configurable in one place.

**Key functions:**
- `saveHistoryToNostr()`: Encrypts and publishes history
- `loadHistoryFromNostr()`: Fetches and decrypts latest history
- `subscribeToHistory()`: Real-time subscription for session changes
- `mergeHistory()`: Combines local and cloud history with conflict resolution

### nostr-crypto.ts

Cryptographic utilities for secure sync.

**Key derivation:**
- User secret (URL hash) → HKDF-SHA256 with salt → secp256k1 keypair
- Secret is 96-bit random, URL-safe Base64 encoded

**Encryption (NIP-44):**
- Ephemeral keypair per encryption
- ECDH shared secret → ChaCha20-Poly1305
- Ciphertext stored in Nostr event content

## Security Model

1. **Secret-based Access**: The URL hash contains the secret key
2. **End-to-End Encryption**: History is encrypted before leaving the device
3. **No Server Trust**: Relays only see encrypted blobs
4. **Session Ownership**: Session ID prevents simultaneous edits

```
URL: https://app.example.com/#<secret>
                               ↓
                    deriveNostrKeys(secret)
                               ↓
              ┌────────────────┴────────────────┐
              ▼                                 ▼
        privateKey                         publicKey
    (decrypt/sign)                      (encrypt/verify)
```

## Resilience & Error Handling

This section documents the current behavior and intended resilience strategy for sync and playback history.

**Relay unavailability**
- ✅ **Current Behavior:** Load/save failures surface as sync status `error` with a user-visible message; local playback/history continues. Subscription setup failures are logged; relay drops can go unnoticed aside from console logs.
- ⚠️ **Intended Behavior (Roadmap):** Graceful local-only mode with a visible “offline/relay unavailable” indicator, retry with exponential backoff, and relay failover across the configured relay list (not implemented).

**Failed encryption/decryption**
- ✅ **Current Behavior:** Decryption errors are surfaced as user-facing errors and logged; bad blobs are not merged.
- ⚠️ **Intended Behavior (Roadmap):** Discard corrupted cloud blobs after repeated failures to prevent blocking future syncs (not implemented).

**Merge conflict strategy (`mergeHistory`)**
- ✅ **Current Behavior:** Deterministic per-URL merge. Default behavior preserves local ordering and adds remote entries that don’t exist locally. If `preferRemote` is enabled (e.g., takeover), remote entries replace local entries for the same URL. If `preferRemoteOrder` is enabled, remote ordering is used and local-only entries are appended. Manual takeover explicitly resolves conflicts by preferring remote content and then re‑publishing as the active session.
- ⚠️ **Intended Behavior (Roadmap):** More granular per-entry reconciliation rules beyond session-based takeover (not implemented).

**Offline/network transience**
- ✅ **Current Behavior:** Auto-save is debounced; failed saves surface errors but are not queued for retry.
- ⚠️ **Intended Behavior (Roadmap):** Maintain a retry queue for pending save operations, apply exponential backoff, and replay queued operations when the network reconnects (not implemented).

**Browser requirements / limitations**
- ✅ **Current Behavior:** Requires Web Crypto API (SubtleCrypto) for key derivation/encryption and uses `localStorage` for history. Relies on network access to Nostr relays; no service worker/offline cache.
- ⚠️ **Intended Behavior (Roadmap):** Provide explicit offline UI guidance and optional local-only mode when relay access is blocked (not implemented).
  Recommended guidance: use modern Chromium/Firefox/Safari; avoid private browsing for persistent history; expect sync to be unavailable when offline or when relay access is blocked by network policy.

## Known Limitations

- No durable retry queue for failed sync operations (errors must be retried manually or via auto‑save once connectivity returns).
- Relay failures can degrade cross‑device sync without local data loss.
- Conflict resolution is session‑based; concurrent active sessions are resolved via takeover rather than per‑field reconciliation.

## Performance & Scalability

- HLS buffer management should favor conservative defaults to avoid large memory spikes on long sessions.
- History is capped at 100 entries; adjust only with clear memory/UX tradeoffs.
- Nostr relays may rate‑limit; prefer debounced writes and backoff (see retry queue roadmap).
- Consider lightweight metrics (sync success rate, save latency, relay error counts, history size).

## Configuration & Environment

- Centralize configurable values (relay list, debounce/heartbeat/retry intervals, poll cadence, storage limits) in one module.
- Document environment variables (if introduced) and default values.
- Keep production vs dev relay lists distinct; avoid shipping private relays in public builds.
- Ensure configuration changes are reflected in both runtime behavior and docs.

## Error Taxonomy

- **Network/Relay:** retry with backoff (roadmap), fail‑safe to local‑only, user‑visible status + logs.
- **Crypto/Decryption:** surface a clear error and skip corrupted blobs; never block local usage.
- **Storage:** handle `localStorage` quota/availability errors with a warning and graceful fallback.
- **State/Concurrency:** avoid stale session writes; require explicit takeover for active conflicts.

## Testing Strategy

- **Unit:** merge rules, session status transitions, and key derivation/validation helpers.
- **Integration:** mock Nostr relays, SubtleCrypto, and clipboard to exercise load/save flows.
- **CI:** include lint + build; add fast tests for retry/backoff logic when implemented.
- **E2E:** scenarios for takeover, stale sessions, relay loss/recovery, and cross‑device resume.

## Playback Position Sync

The pending seek mechanism ensures reliable position restoration:

1. `loadFromHistory()` sets `pendingSeekPositionRef.current`
2. Multiple audio events trigger `applyPendingSeek()`
3. For HLS, waits for `seekable` ranges to be available
4. Sets `audio.currentTime` and waits for `seeked` event
5. Verifies position within 0.5s tolerance
6. Retries up to 20 times with 250ms intervals

## State Management

State is managed locally within components using React hooks:

- **AudioPlayer**: Player state (url, isPlaying, currentTime, volume, etc.)
- **NostrSyncPanel**: Sync state (status, sessionStatus, message)
- **Cross-component**: Props callbacks (onHistoryLoaded, onTakeOver)

No global state management library is used; state flows through props.

## Cross-Tab Sync

Local cross-tab synchronization via visibility API:

1. On pause, record `pausedAtTimestamp`
2. On tab visibility, check `HISTORY_TIMESTAMP_KEY` in localStorage
3. If history was updated after pause, reload latest entry
