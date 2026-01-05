# Audio Player Architecture

## Overview

This is an audio player built with React and TypeScript that supports cross-device synchronization via the Nostr protocol. The application allows users to play standard audio files and HLS streams, track playback history, and sync their listening position across multiple devices using encrypted Nostr events.

## Key Architecture

The application uses a layered key architecture for identity and encryption:

```
URL: #npub1abc...xyz
        │
        ▼
┌──────────────────┐
│  Secondary       │  (user-entered per device, stored in localStorage)
│  Secret          │  (encrypts player ID using AES-GCM)
└──────────────────┘
        │
        ▼
┌──────────────────┐
│  Player ID       │  (on relay: encrypted with secondary secret, signed by nsec)
│                  │  (fetched from relay on each session start)
│                  │  (derives keys for history encryption AND signing)
└──────────────────┘
        │
        ▼
┌──────────────────┐
│  Encrypted       │  (Kind 30078, d-tag: audioplayer-history-v1)
│  History         │  (encrypted AND signed with player ID derived keys)
└──────────────────┘
```

**Key points:**
- **npub**: Public, safe to share in URL - identifies the user
- **Secondary secret**: User-controlled, encrypts player ID only, must be transferred manually between devices
- **Player ID**: 43-char URL-safe base64 (32 bytes), fetched from relay (not cached locally), derives keys for history
- **nsec**: Only needed for initial setup and player ID rotation (signs player ID events)
- **History events**: Authored by player ID public key (not npub), encrypted with player ID derived keys

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite
- **Styling**: Tailwind CSS, shadcn/ui components
- **HLS Playback**: hls.js
- **Sync Protocol**: Nostr (nostr-tools)
- **Encryption**: NIP-44 (for history), AES-GCM (for player ID)

## Core Components

### AudioPlayer (`components/AudioPlayer.tsx`)

The main player component with two layers:

1. **AudioPlayer (outer)**: Creates a stable sessionId and renders `AudioPlayerInner`
2. **AudioPlayerInner**: Contains all playback logic

Key features:
- HLS stream loading via hls.js
- Live stream detection (disables seeking for live content)
- Playback position tracking and restoration
- Pending seek mechanism with retry logic for reliable position sync
- Web Audio API gain control for volume boost beyond 100%
- History management with auto-save every 5 seconds during playback (non-live streams)

### NostrSyncPanel (`components/NostrSyncPanel.tsx`)

Orchestrates cross-device synchronization by connecting session management with sync logic:

- **Session Management**: Coordinates with `useNostrSession` for active/stale status
- **Sync Delegation**: Uses `useNostrSync` for all sync operations
- **Takeover UI**: Provides controls for claiming sessions from other devices
- **Storage Fingerprint**: Computes and propagates fingerprint from npub to parent for scoped localStorage access; displays fingerprint in `XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX` format in Details panel

### useNostrSession (`hooks/useNostrSession.ts`)

Manages identity, player ID, and session state:

- **Session Status**: Tracks `no_npub`, `needs_secret`, `loading`, `needs_setup`, `idle`, `active`, `stale`, or `invalid` status
- **Identity Flow**: Parses npub from URL hash, validates format, derives fingerprint for localStorage scoping
- **Secondary Secret**: Checks localStorage for cached secret, prompts user if missing
- **Player ID Loading**: Fetches encrypted player ID from relay, decrypts with secondary secret
- **Setup Flow**: If no player ID exists, requires nsec to create initial one
- **Key Derivation**: Derives encryption keys from player ID via HKDF-SHA256
- **Takeover Grace**: Provides `ignoreRemoteUntil` timestamp to suppress remote events briefly after takeover
- **Session ID**: Generates unique session IDs via `generateSessionId()` (32-char hex, 16 bytes)

**Key actions:**
- `submitSecondarySecret(secret)`: Stores secret, attempts to load player ID from relay
- `setupWithNsec(nsec)`: Creates new player ID, encrypts with secondary secret, signs and publishes
- `rotatePlayerId(nsec)`: Generates new player ID (old history becomes inaccessible)
- `generateNewIdentity()`: Creates new npub/nsec pair

### useNostrSync (`hooks/useNostrSync.ts`)

Handles all Nostr synchronization using a master-slave architecture (inspired by NostrPad):

- **Idle State Support**: `performInitialLoad()` fetches history read-only without claiming session
- **Session Start**: `startSession()` explicitly claims the session when user clicks "Start Session"
- **Timestamp-based Ordering**: Uses millisecond timestamps embedded in payloads for reliable event ordering
- **Real-time Subscription**: Subscribes to Nostr events for instant cross-device updates
- **Auto-save**: Debounced saves when history changes (5s delay, only when active)
- **Live Position Updates**: Publishes position every 5s during active playback for slave device sync
- **Local Change Protection**: Uses `isLocalChangeRef` to prevent remote overwrites during local operations
- **Duplicate Prevention**: Uses `pendingPublishRef` to avoid concurrent publishes
- **Stale Transition**: Only transitions to `stale` from `active` state (idle stays idle)

## Data Flow

### Local History Flow

```
User Action → AudioPlayer → saveCurrentPosition() → localStorage
                                    ↓
                              history state update
```

### Nostr Sync Flow (Master-Slave Architecture)

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────┐     ┌─────────────┐
│  AudioPlayer    │────▶│  NostrSyncPanel  │────▶│  useNostrSync│────▶│ Nostr Relays│
│  (history state)│◀────│  (orchestration) │◀────│  (sync logic)│◀────│ (storage)   │
└─────────────────┘     └──────────────────┘     └──────────────┘     └─────────────┘
         │                       │                      │
         ▼                       ▼                      ▼
   localStorage           useNostrSession      Subscription (real-time)
                          (session state)      + Live position updates
```

**Sync ordering**: Events are ordered by embedded millisecond timestamps in the encrypted payload (`HistoryPayload.timestamp`), not by Nostr event `created_at` (which has only second precision). This ensures reliable ordering even with rapid updates.

### Session State Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SESSION STATES                               │
├─────────────────────────────────────────────────────────────────────┤
│  no_npub      │  No npub in URL, show "Generate New Identity"       │
│  needs_secret │  Has npub, needs secondary secret entry             │
│  loading      │  Fetching player ID from relay                      │
│  needs_setup  │  No player ID exists, needs nsec to create one      │
│  idle         │  Ready, has player ID, session not started          │
│  active       │  Session claimed, can edit and sync                 │
│  stale        │  Another device took over, read-only until reclaim  │
│  invalid      │  Invalid npub format in URL                         │
└─────────────────────────────────────────────────────────────────────┘

Page Load Flow:
───────────────
  No npub in URL → "no_npub"
       ↓
  [Generate New Identity] → show credentials → enter secret
       ↓
  npub set in URL hash → "needs_secret"

  npub in URL (invalid format) → "invalid" (error shown)

  npub in URL (valid) + no cached secret → "needs_secret"
       ↓
  [Submit Secondary Secret] → "loading"
       ↓
  Player ID found → "idle"
  Player ID not found → "needs_setup"
       ↓
  [Enter nsec] → create player ID → "idle"

  npub in URL + cached secret → "loading"
       ↓
  Decrypt player ID from relay → "idle"
       ↓
  [Start Session] → "active"


State Transitions:
──────────────────
  no_npub ──[Generate Identity]──▶ (show credentials) ──▶ needs_secret
  needs_secret ──[Submit Secret, found player ID]──▶ idle
  needs_secret ──[Submit Secret, no player ID]──▶ needs_setup
  needs_setup ──[Setup with nsec]──▶ idle
  idle ──[Start Session]──▶ active
  active ──[Remote takeover]──▶ stale
  stale ──[Take Over Session]──▶ active
  idle ──[Remote event]──▶ idle (history updated, state unchanged)
  stale ──[Remote event]──▶ stale (history updated, state unchanged)
```

**Transition Triggers:**

| Transition | Trigger | Mechanism |
|------------|---------|-----------|
| `no_npub` → `needs_secret` | User clicks "Generate New Identity" | `generateNewIdentity()` creates npub/nsec, sets URL hash |
| `needs_secret` → `loading` | User submits secondary secret | `submitSecondarySecret()` stores secret, fetches player ID |
| `loading` → `idle` | Player ID decrypted successfully | `loadPlayerIdFromNostr()` returns valid player ID |
| `loading` → `needs_setup` | No player ID event exists | `checkPlayerIdEventExists()` returns false |
| `needs_setup` → `idle` | User enters nsec | `setupWithNsec()` creates and publishes player ID |
| `idle` → `active` | User clicks "Start Session" | `startSession()` publishes with new sessionId, starts 15s grace period |
| `active` → `stale` | Remote event with different sessionId | `subscribeToHistoryDetailed()` detects foreign sessionId in payload |
| `active` → `stale` | Tab regains focus after takeover | Visibility handler fetches latest event, detects different sessionId |
| `stale` → `active` | User clicks "Take Over Session" | Re-claims with new sessionId |

**Timeout/Heartbeat Behavior:**
- No heartbeat or timeout-based stale detection exists.
- Active sessions publish position updates every 5s during playback, but silent disconnections (e.g., browser closed) are not detected.
- A device remains "active" indefinitely until another device explicitly takes over.
- **Visibility-based validation:** When a tab regains focus and the session was active, the hook fetches the latest Nostr event to verify no other device has taken over. If a newer event with a different sessionId is found, the session transitions to stale.
- See [ROADMAP.md](./ROADMAP.md) for planned improvements.

### Session Takeover Flow

```
From Idle (first time claiming):
1. User clicks "Start Session"
2. startSession() calls performLoad(secret, isTakeOver=true)
3. Grace period starts (15s)
4. Saves with new sessionId → "active"

From Stale (reclaiming):
1. Device B clicks "Take Over Session"
2. NostrSyncPanel.performLoad(secret, isTakeOver=true)
3. Fetches and decrypts cloud history
4. Calls onTakeOver(cloudHistory)
5. AudioPlayer.handleRemoteSync(cloudHistory)
6. AudioPlayer loads entry with forceReset (no remount)
7. Pending seek mechanism restores playback position
```

## Library Modules

### identity.ts

Identity management with localStorage scoping by npub fingerprint.

```typescript
interface IdentityState {
  npub: string;
  pubkeyHex: string;
  playerId: string | null;
  hasSecondarySecret: boolean;
}
```

**Storage Keys (scoped by npub fingerprint):**

All localStorage keys are scoped by npub fingerprint for isolation:

| Key Pattern | Description |
|-------------|-------------|
| `com.audioplayer.secondary-secret.{fingerprint}` | Secondary secret for this npub |
| `com.audioplayer.nsec.{fingerprint}` | Optional stored nsec (user convenience) |
| `com.audioplayer.history.v1.{fingerprint}` | History payload (entries + timestamp + sessionId) |

The fingerprint is a 32-character hex string (first 128 bits of SHA-256 hash of the pubkeyHex).

**Key functions:**

- `getStorageScope(pubkeyHex)`: Generates 32-char hex fingerprint from pubkey for localStorage scoping (async, uses SubtleCrypto)
- `getSecondarySecret(fingerprint)`: Retrieves secondary secret from localStorage
- `setSecondarySecret(fingerprint, secret)`: Stores secondary secret
- `getStoredNsec(fingerprint)`: Retrieves optional stored nsec
- `storeNsec(fingerprint, nsec)`: Stores nsec for convenience
- `clearAllIdentityData(fingerprint)`: Clears all data for a fingerprint

**Note:** Player ID is NOT cached locally - it's always fetched from relay using the secondary secret.

### history.ts

History types and local storage helpers.

```typescript
interface HistoryEntry {
  url: string;          // Stream URL
  title?: string;       // Optional title
  lastPlayedAt: string; // ISO timestamp
  position: number;     // Playback position in seconds
  gain?: number;        // Optional volume boost level
}

interface HistoryPayload {
  history: HistoryEntry[];  // Array of history entries
  timestamp: number;        // Date.now() milliseconds for ordering
  sessionId?: string;       // Session ID of the publisher
}
```

**Key functions:**

- `getHistory(fingerprint?)`: Retrieves validated history entries from localStorage (scoped by fingerprint)
- `getHistoryTimestamp(fingerprint?)`: Retrieves timestamp of last history update (for cross-tab sync)
- `saveHistory(history, fingerprint?, sessionId?)`: Persists history payload atomically (entries + timestamp + sessionId)
- `validateHistoryPayload()` lives in `nostr-crypto.ts` (payload validation after decryption)
- Max 100 entries (trimmed on save)

### nostr-sync.ts

Nostr protocol integration for cloud sync.

**Relays used:**
- wss://nos.lol
- wss://relay.nostr.band
- wss://relay.nostr.net
- wss://relay.primal.net
- wss://relay.snort.social

**Event structure (NIP-78):**
- Kind: 30078 (application-specific replaceable)
- d-tag: "audioplayer-playerid-v1" (player ID events, signed by nsec)
- d-tag: "audioplayer-history-v1" (history events, signed by player ID derived key)

**Player ID events:**
- Authored by user's npub (signed by nsec)
- Content: player ID encrypted with secondary secret (AES-GCM)
- Only created during initial setup or rotation

**History events:**
- Authored by player ID public key (NOT npub)
- Content: history encrypted with player ID derived key (NIP-44)
- Signed by player ID derived private key

**Session tag strategy**
- 32-char hex string (16 bytes) generated via `generateSessionId()` per client session (128 bits of randomness).

**Stale-session detection**
- Real-time subscription detects remote session activity via `HistoryPayload.sessionId`. When a remote event with a different sessionId arrives, the local session transitions to `stale` status only if currently `active`. Idle sessions stay idle (they haven't claimed the session yet).
- **Idle state:** Page load with valid npub and secondary secret starts in `idle` state after loading player ID. User must click "Start Session" to claim. This prevents race conditions and confusion about session ownership.
- **Takeover grace period:** After taking over a session, remote events are ignored for a configurable grace period (`ignoreRemoteUntil`) to prevent immediate re-staling from delayed events.
- **Live position sync:** Active sessions publish position updates every 5s during playback, allowing idle/stale devices to track playback position.

**Key functions (nostr-sync.ts):**
- `publishPlayerIdToNostr()`: Encrypts player ID with secondary secret, signs with nsec, publishes
- `loadPlayerIdFromNostr()`: Fetches player ID event, decrypts with secondary secret
- `checkPlayerIdEventExists()`: Checks if player ID event exists for a pubkey
- `saveHistoryToNostr()`: Encrypts and publishes history using player ID derived keys
- `loadHistoryFromNostr()`: Fetches and decrypts history using player ID derived keys
- `subscribeToHistoryDetailed()`: Real-time subscription using player ID public key
- `mergeHistory()`: Combines local and cloud history with conflict resolution

**Key functions (useNostrSync.ts):**
- `performInitialLoad()`: Fetches history read-only without claiming session (for idle state)
- `startSession()`: Claims session by calling performLoad with isTakeOver=true
- `performLoad()`: Fetches and optionally claims session
- `performSave()`: Encrypts and publishes current history using encryptionKeys only
- Visibility change handler: Validates active session on tab focus by fetching latest event and checking sessionId

### nostr-crypto.ts

Cryptographic utilities for secure sync.

**Player ID format:**
- 32 bytes random, URL-safe base64 encoded (43 characters, no padding)
- Characters: A-Z, a-z, 0-9, `-`, `_`
- `generatePlayerId()`: Creates new player ID
- `isValidPlayerId(playerId)`: Validates length and URL-safe base64 format

**Session ID format:**
- 16 bytes random, hex encoded (32 characters)
- `generateSessionId()`: Creates new session ID for multi-device coordination

**Secondary secret format:**
- 11 bytes random + 1 byte CRC-8 checksum = 12 bytes total
- URL-safe Base64 encoded → 16 characters
- Checksum enables fail-fast validation
- `generateSecondarySecret()`: Creates new secondary secret with embedded checksum
- `isValidSecondarySecret(secret)`: Validates length, format, and checksum

**npub/nsec utilities:**
- `parseNpubFromHash(hash)`: Extracts and validates npub from URL hash, returns hex pubkey
- `decodeNsec(nsec)`: Decodes nsec to private key bytes
- `generateNostrKeypair()`: Creates new npub/nsec keypair

**Player ID encryption (AES-GCM):**
- `encryptWithSecondarySecret(data, secondarySecret)`: Encrypts player ID
- `decryptWithSecondarySecret(ciphertext, secondarySecret)`: Decrypts player ID

**Key derivation from player ID:**
- Player ID → HKDF-SHA256 with salt → secp256k1 keypair
- `deriveEncryptionKey(playerId)`: Derives keys for history encryption AND signing

**History encryption (NIP-44):**
- Ephemeral keypair per encryption
- ECDH shared secret → ChaCha20-Poly1305
- `encryptHistory(data, publicKey, sessionId?)`: Encrypts history with embedded `HistoryPayload`
- `decryptHistory(ciphertext, ephemeralPubKey, privateKey)`: Returns full `HistoryPayload`

## Security Model

1. **npub-based Identity**: URL hash contains public key (npub), safe to share
2. **Secondary Secret**: Per-device secret encrypts player ID only
3. **Player ID Derived Keys**: History encrypted AND signed with keys derived from player ID
4. **End-to-End Encryption**: History is encrypted before leaving the device
5. **No Server Trust**: Relays only see encrypted blobs
6. **Session Ownership**: Session ID prevents simultaneous edits

```
URL: https://app.example.com/#npub1abc...
                               │
                    parseNpubFromHash()
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
          invalid                            valid
    (show error, block sync)                   │
                                               ▼
                                    getSecondarySecret()
                                               │
                              ┌────────────────┴────────────────┐
                              ▼                                 ▼
                         missing                            present
                    (prompt user entry)                        │
                                               ▼
                                    loadPlayerIdFromNostr()
                                               │
                              ┌────────────────┴────────────────┐
                              ▼                                 ▼
                      not found                              found
                (needs nsec for setup)                         │
                                               ▼
                                    deriveEncryptionKey(playerId)
                                               │
                              ┌────────────────┴────────────────┐
                              ▼                                 ▼
                        privateKey                         publicKey
                  (decrypt/sign history)              (encrypt/query history)
```

## Resilience & Error Handling

This section documents the current behavior for sync and playback history. See [ROADMAP.md](./ROADMAP.md) for planned improvements.

**Relay unavailability**
- Load/save failures surface as sync status `error` with a user-visible message; local playback/history continues.
- Subscription setup failures are logged; relay drops can go unnoticed aside from console logs.

**Failed encryption/decryption**
- Load/decryption errors surface as user-facing errors; subscription decryption errors are logged only. Bad blobs are not merged.

**Merge conflict strategy (`mergeHistory`)**
- Remote is source of truth for idle/stale sessions (list order, titles, gain, new URLs).
- Local position is preserved only when local `lastPlayedAt` timestamp is newer for the same URL.
- Manual takeover re-publishes as the active session.

**Offline/network transience**
- Auto-save is debounced; failed saves surface errors but are not queued for retry.

**Browser requirements / limitations**
- Requires Web Crypto API (SubtleCrypto) for key derivation/encryption.
- Uses `localStorage` for history persistence.
- Relies on network access to Nostr relays; no service worker/offline cache.
- Recommended: use modern Chromium/Firefox/Safari; avoid private browsing for persistent history.

## Known Limitations

- No durable retry queue for failed sync operations (errors must be retried manually or via auto‑save once connectivity returns).
- Relay failures can degrade cross‑device sync without local data loss.
- Conflict resolution is session‑based; concurrent active sessions are resolved via timestamp-based takeover.
- See [ROADMAP.md](./ROADMAP.md) for planned improvements to address these limitations.

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

- **Network/Relay:** Fail‑safe to local‑only, user‑visible status + logs.
- **Crypto/Decryption:** Surface a clear error and skip corrupted blobs; never block local usage.
- **Storage:** Handle `localStorage` quota/availability errors with a warning and graceful fallback.
- **State/Concurrency:** Avoid stale session writes; require explicit takeover for active conflicts.

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
2. On tab visibility, check history timestamp via `getHistoryTimestamp(fingerprint)` (stored atomically with history payload)
3. If history was updated after pause, reload latest entry from scoped storage
