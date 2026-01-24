---
name: architecture
description: "Chrome Extension mimarisi (Manifest V3). Script türleri (content/page/background), MAIN world injection, veri akışı (postMessage → storage → UI). Kullan: mimari soru, script iletişimi, world isolation, mesaj akışı, storage pattern"
---

# Extension Mimarisi

Chrome Extension (Manifest V3) yapısı. MAIN world injection ile WebRTC/Audio API hook'lama.

## Script Türleri ve Context'ler

| Script | Context | Erişim | Dosya |
|--------|---------|--------|-------|
| **background.js** | Service Worker | chrome.* API, lifecycle events | `scripts/background.js` |
| **content.js** | ISOLATED world | DOM, mesajlaşma, storage | `scripts/content.js` |
| **early-inject.js** | MAIN world | API Proxy (en erken) | `scripts/early-inject.js` |
| **page.js** | MAIN world | WebRTC/Audio API'leri | `scripts/page.js` |
| **popup.js** | Extension UI | chrome.storage, UI | `scripts/popup.js` |

## MAIN World Injection

**Problem:** Content scripts ISOLATED world'de → `window.RTCPeerConnection`'a erişemez.

**Çözüm:** İki aşamalı injection:

```javascript
// manifest.json - En erken hook (document_start)
"content_scripts": [{
  "js": ["scripts/early-inject.js"],
  "world": "MAIN",
  "run_at": "document_start"
}]

// background.js - PageInspector injection
await chrome.scripting.executeScript({
  target: { tabId, frameIds: [frameId] },
  world: 'MAIN',
  files: ['scripts/page.js']
});
```

**Yükleme Sırası:**
1. `early-inject.js` → Constructor Proxy'leri (AudioContext, RTCPeerConnection, vb.)
2. Sayfa script'leri çalışır (API'ler zaten hook'lu)
3. `page.js` → PageInspector başlar, early captures sync edilir

## Temel Veri Akışı

```
[MAIN World]
  Collectors → emit(data) → PageInspector._report()
       ↓ window.postMessage()
[ISOLATED World]
  content.js listener → chrome.storage.local.set()
       ↓ storage.onChanged
[Popup]
  popup.js listener → updateUI()
```

## Storage Keys

**State:**
- `inspectorEnabled` - Inspector aktif mi
- `lockedTab` - `{ id, url, title }` kilitli tab
- `pendingAutoStart` - Refresh sonrası auto-start için tab ID
- `recording_active` - `{ active, timestamp, sourceTabId }` kayıt durumu (tek kaynak)

**Data (DATA_STORAGE_KEYS):**
- `rtc_stats`, `user_media`, `audio_contexts`, `audio_worklet`
- `media_recorder`, `detected_encoder`, `audio_connections`, `recording_active`

**Persistent:**
- `debug_logs` - Merkezi log kayıtları
- `platformInfo` - Platform algılama (temizlenmez)

## Kontrol Mesajları

| Mesaj | Yön | Amaç |
|-------|-----|------|
| `INSPECTOR_READY` | page→content | PageInspector hazır |
| `PAGE_READY` | content→background | Sayfa hazır, karar iste |
| `SET_ENABLED` | popup→content→page | Inspector aç/kapat |
| `RE_EMIT_ALL` | content→page | Collector'lar veriyi yeniden emit etsin |
| `ADD_LOG` | content→background | Merkezi log ekleme |
| `GET_TAB_ID` | content→background | Content script'in kendi tab ID'sini öğrenmesi |
| `GET_STORAGE_KEYS` | content/popup→background | DRY: Storage key listesi al |
| `CLEAR_INSPECTOR_DATA` | content/popup→background | DRY: Merkezi veri temizleme |
| `AUTO_STOP_NEW_RECORDING` | page→content | İkinci kayıtta inspector'ı durdur |
| `RECORDING_STATE` | early-inject→content | Kayıt durumu değişikliği (start/stop) |

## Merkezi State Yönetimi (Centralized Approach)

**Tek Doğru Kaynak:** `background.js` TÜM state kararlarını verir.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        background.js                                 │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ handlePageReady() - Merkezi karar mantığı                    │   │
│  │                                                               │   │
│  │ Decision Matrix:                                              │   │
│  │ ┌────────────────┬──────────────┬───────────┬────────────┐   │   │
│  │ │ pendingAuto    │ enabled      │ sameTab   │ Action     │   │   │
│  │ ├────────────────┼──────────────┼───────────┼────────────┤   │   │
│  │ │ YES (=tabId)   │ -            │ -         │ START      │   │   │
│  │ │ NO             │ YES          │ YES+same  │ START      │   │   │
│  │ │ NO             │ YES          │ YES+diff  │ STOP       │   │   │
│  │ │ NO             │ NO           │ YES       │ NONE+clean │   │   │
│  │ │ NO             │ NO           │ NO        │ NONE       │   │   │
│  │ └────────────────┴──────────────┴───────────┴────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Also handles: tab close, tab switch, window switch, cross-origin   │
└─────────────────────────────────────────────────────────────────────┘
          │
          │ response: { action: 'START'|'STOP'|'NONE', reason }
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        content.js                                    │
│  - Sadece mesaj iletir, karar VERMEZ                                │
│  - PAGE_READY gönderir, response'a göre hareket eder                │
│  - SET_ENABLED'ı page.js'e forward eder                             │
└─────────────────────────────────────────────────────────────────────┘
```

**Neden Merkezi?**
- Race condition önleme (storage okuma/yazma sırası)
- Duplicate mantık yok (cross-origin kontrolü tek yerde)
- Tutarlı davranış (refresh, navigation, tab switch aynı sonuç)

## Detaylı Referanslar

Aşağıdaki konular için ilgili reference dosyasını oku:

- **Lifecycle & Cleanup:** [references/lifecycle.md](references/lifecycle.md)
  - Log cleanup, tab close, window close, navigation
  - clearInspectorData() helper'ları
  - Auto-stop mekanizması

- **Storage & Async Patterns:** [references/patterns.md](references/patterns.md)
  - storage.onChanged listener pattern
  - Async storage clearing (race condition fix)
  - Force restart logic
  - DRY: DATA_STORAGE_KEYS message pattern
  - DRY: clearInspectorData centralized pattern

- **Tab Locking:** [references/tab-locking.md](references/tab-locking.md)
  - Tab kilitleme akışı
  - Farklı tab'dan stop
  - Second start refresh modal
  - pendingAutoStart flow

- **UI States & Rendering:** [references/ui-states.md](references/ui-states.md)
  - Banner display states
  - Popup tab listeners
  - Encoding section rendering
  - Pipeline/chain rendering
  - Constants mirroring (popup.js ↔ constants.js)

## Klasör Yapısı

```
src/
├── collectors/       # API hook modülleri (→ collectors skill)
├── core/
│   ├── utils/
│   │   ├── ApiHook.js      # hookMethod, hookAsyncMethod
│   │   ├── EarlyHook.js    # Constructor Proxy, registry
│   │   └── CodecParser.js  # Codec parsing
│   ├── Logger.js
│   └── constants.js        # DATA_TYPES, EVENTS, streamRegistry
└── page/PageInspector.js   # Ana orkestratör
```

## Debug

```javascript
window.__pageInspector                   // Inspector instance
window.__earlyCaptures                   // Early hook registry
window.__detectedEncoderData             // Encoder tespiti (WASM, PCM, native)
window.__recordingState                  // Recording durumu (active, sessionCount, etc.)
window.__audioInspectorAnalyserUsageMap  // AnalyserNode usageType tespiti (WeakMap)
window.__audioInspectorNodeIdMap         // AudioNode ID mapping (WeakMap)
window.__audioInspectorContextIdMap      // AudioContext ID mapping (WeakMap)
```
