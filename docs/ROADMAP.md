# Roadmap

This document tracks planned improvements and known limitations for the audio player sync system.

## Session Management

### Heartbeat-Based Inactive Detection
- **Status:** Not implemented
- **Description:** Mark sessions as stale after N minutes without updates
- **Current behavior:** A device remains "active" indefinitely until another device explicitly takes over. Silent disconnections (e.g., browser closed) are not detected.
- **Proposed:** Implement heartbeat mechanism where active sessions must publish periodic keep-alive signals. Sessions without updates for a configurable timeout are automatically marked as inactive.

### Concurrent Offline Active Sessions
- **Status:** Not implemented
- **Description:** Handle the case where multiple devices go offline while both have active sessions, then come back online
- **Current behavior:** When both devices come online:
  1. Both devices believe they are "active" and will attempt to publish
  2. Both subscriptions will receive the other device's event
  3. The device with the older `HistoryPayload.timestamp` transitions to "stale"
  4. The "winner" is determined purely by timestamp, not by which device was actually in active use
  5. Data from both sessions is merged via position timestamp comparison
- **Issues:**
  - Race condition: the outcome depends on which device publishes first after reconnecting
  - No user notification that a conflict occurred
  - The user who was actively using the "losing" device may be confused when their session suddenly becomes stale
- **Proposed:**
  - Detect concurrent active session conflict (same secret, different sessionIds, both claiming active)
  - Present user with a conflict resolution UI showing both histories
  - Allow user to choose which session to keep or merge manually

## Resilience & Error Handling

### Graceful Offline Mode
- **Status:** Not implemented
- **Description:** Improve behavior when relays are unavailable
- **Current behavior:** Load/save failures surface as sync status `error` with a user-visible message; local playback/history continues. Subscription setup failures are logged.
- **Proposed:**
  - Visible "offline/relay unavailable" indicator
  - Retry with exponential backoff
  - Relay failover across the configured relay list

### Corrupted Blob Handling
- **Status:** Not implemented
- **Description:** Handle repeatedly corrupted cloud data
- **Current behavior:** Decryption errors are surfaced as user-facing errors and logged; bad blobs are not merged.
- **Proposed:** Discard corrupted cloud blobs after repeated failures to prevent blocking future syncs.

### Retry Queue for Failed Saves
- **Status:** Not implemented
- **Description:** Queue and retry failed sync operations
- **Current behavior:** Auto-save is debounced; failed saves surface errors but are not queued for retry.
- **Proposed:**
  - Maintain a retry queue for pending save operations
  - Apply exponential backoff
  - Replay queued operations when the network reconnects

### Explicit Offline UI Guidance
- **Status:** Not implemented
- **Description:** Better UX for offline scenarios
- **Current behavior:** Requires Web Crypto API and uses localStorage for history. No service worker/offline cache.
- **Proposed:**
  - Provide explicit offline UI guidance
  - Optional local-only mode when relay access is blocked
  - Recommended guidance: use modern Chromium/Firefox/Safari; avoid private browsing for persistent history

## Security Enhancements

### Non-Extractable Web Crypto Key Storage
- **Status:** Idea / Not implemented
- **Description:** Store secondary secret as a non-extractable CryptoKey in IndexedDB
- **Current behavior:** Secondary secret is stored as plaintext in localStorage. While it never leaves the client, any JavaScript on the same origin could read it.
- **Proposed:**
  - Import secondary secret as a non-extractable AES-GCM key using Web Crypto API
  - Store the CryptoKey object in IndexedDB (which supports structured clone of CryptoKey)
  - Use the key for encryption/decryption operations without ever being able to extract the raw material
  - Benefits: Prevents accidental logging, analytics capture, or XSS from extracting the secret
  - Limitations: Still vulnerable to same-origin JS using the key (just can't read it); user must still enter secret on first use per device
- **Implementation sketch:**
  ```typescript
  // Import as non-extractable key
  const key = await crypto.subtle.importKey(
    "raw", secretBytes, "PBKDF2", false, ["deriveKey"]
  );
  // Store in IndexedDB
  await db.put("keys", key, "secondary-secret");
  // Retrieve and use - can encrypt/decrypt but never read key material
  ```

## Playlist Management

### Separate Groups for Live Streams and VOD
- **Status:** Not implemented
- **Description:** Group history entries by content type (live streams vs VOD) for easier management
- **Current behavior:** All history entries are displayed in a single flat list sorted by last played time, regardless of whether they are live streams or VOD content.
- **Proposed:**
  - Detect content type based on HLS manifest (live vs VOD) or URL patterns
  - Display separate collapsible sections for "Live Streams" and "VOD Playlist"
  - Allow bulk operations (clear, export) per group
  - Persist content type classification in history entries for faster rendering

