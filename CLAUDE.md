# VoiceInspector - Project Guidelines

## Klasör Yapısı

```
voice-inspector/
├── .claude/              # Claude Code configuration & skills
│   ├── settings.json     # Skill registration
│   ├── README.md         # Skill index
│   └── skills/           # Custom skills
│       ├── architecture/SKILL.md
│       ├── collectors/SKILL.md
│       └── skill-controller/SKILL.md
│
├── src/                  # Modular application code
│   ├── core/             # Utilities & constants
│   │   ├── utils/ApiHook.js
│   │   ├── Logger.js
│   │   └── constants.js
│   ├── collectors/       # Data collection modules
│   │   ├── BaseCollector.js
│   │   ├── RTCPeerConnectionCollector.js
│   │   ├── GetUserMediaCollector.js
│   │   ├── AudioContextCollector.js
│   │   └── MediaRecorderCollector.js
│   ├── detectors/        # Platform detection
│   │   ├── RegexDetector.js
│   │   └── platforms/
│   │       └── StandardDetectors.js
│   └── page/             # Main orchestrator
│       └── PageInspector.js
│
├── scripts/              # Extension script files
│   ├── background.js     # Service worker (Manifest V3)
│   ├── content.js        # Content script (ISOLATED world)
│   ├── page.js           # Page script (MAIN world - hooks & APIs)
│   ├── popup.js          # Popup UI logic
│
├── views/                # HTML templates
│   └── popup.html        # Popup interface
│
├── images/               # Icons & visual assets
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
│
├── tests/                # Test files
│   └── test.html
│
├── manifest.json         # Extension manifest (Manifest V3)
├── README.md             # Main documentation
├── INSTALL.md            # Installation guide
├── ICONS.md              # Icon documentation
└── CLAUDE.md             # This file (project guidelines)
```

## Dosya Amaçları

### Extension Scripts (`/scripts`)
- **background.js** - Service worker, API injection, event handling
- **content.js** - Content script bridge (ISOLATED world), message relay
- **page.js** - Page script (MAIN world), WebRTC API hooks, data collection
- **popup.js** - Popup UI logic, state management, event handlers

### Views & Assets (`/views`, `/images`)
- **popup.html** - Extension popup template
- **icon*.png** - Extension icons (16x16, 48x48, 128x128)

### Core Application (`/src`)
- **PageInspector** - Main orchestrator. Instantiates collectors and handles direct reporting via `postMessage`.
- **Collectors** - API hooks (RTCPeerConnection, getUserMedia, AudioContext, MediaRecorder)
- **Detectors** - Platform detection (Teams, Discord, Zoom, etc.)

## Architecture Overview

### Extension Lifecycle

```
User installs extension
         ↓
manifest.json loads scripts
         ↓
background.js (Service Worker) starts
         ↓
content.js injects → page.js (MAIN world)
         ↓
page.js hooks WebRTC APIs via PageInspector
         ↓
Collectors emit data → PageInspector
         ↓
PageInspector → window.postMessage()
         ↓
content.js receives → chrome.storage.local
         ↓
popup.js reads → displays UI
```

### Data Flow

```
[MAIN world - page.js / PageInspector]
  RTCPeerConnection, getUserMedia, AudioContext hooks
         ↓
  PageInspector._report() → window.postMessage()
         ↓
[ISOLATED world - content.js]
  postMessage listener → chrome.storage.local.set()
         ↓
[Popup context - popup.js]
  chrome.storage.local.get() → updateUI()
         ↓
[UI - popup.html]
  Display WebRTC stats, inspector status (Started/Stopped), controls
```

### State Management

- **inspectorEnabled** (page.js) - Controls polling & data collection
- **platformInfo** (chrome.storage.local) - Platform detection (persistent)
- **audioData** (chrome.storage.local) - Latest stats data

### Control Messages

**page.js → content.js** (Initialization)
- `INSPECTOR_READY` - PageInspector signals it's ready for commands (race condition fix)

**popup.js → content.js → page.js** (User actions)
- `SET_ENABLED` - Toggle stats collection on/off
- `FORCE_REFRESH` - Immediate stats collection

**content.js → page.js** (State restoration)
- `SET_ENABLED` - Restore inspector state after INSPECTOR_READY signal

## Skill Routing

Üç özel skill mevcut (`.claude/skills/`):

| Skill | Amaç | Tetikleyici Kelimeler |
|-------|------|----------------------|
| **architecture** | Extension mimarisi, script türleri, veri akışı | mimari, manifest, content script, main world, postMessage |
| **collectors** | Collector yazma, API hooking | collector, hook, rtcpeerconnection, getusermedia, emit |
| **skill-controller** | Skill denetimi | skill audit, skill kontrol, senkronizasyon |

Detaylı bilgi: `.claude/README.md`

## Development Guidelines

### Adding New Collectors

1. Create new file: `src/collectors/MyCollector.js`
2. Extend `BaseCollector` from `src/collectors/BaseCollector.js`
3. Implement `initialize()`, `start()`, `stop()` methods
4. Add to `src/page/PageInspector.js` instantiation list

Detaylı rehber: **collectors** skill'i

### Adding New Detectors

1. Add detector definition to `src/detectors/platforms/StandardDetectors.js`

### File Path Rules

- Manifest-referenced files MUST be in `/scripts`
- HTML templates MUST be in `/views`
- Icons MUST be in `/images`
- Modular code MUST be in `/src`
- Test files MUST be in `/tests`

### Important Notes

- Do NOT modify manifest.json without updating file paths in this guide
- MAIN world injection (page.js) requires Chrome extension API permissions
- Content script is ISOLATED - cannot access page variables directly
- Platform info persists across storage clears (preserved by popup.js)
- Stats polling controlled by extension enabled state

## Testing

After refactoring or adding features:

```bash
1. Open chrome://extensions/
2. Click reload on VoiceInspector
3. Open DevTools (F12) → Console
4. Check for errors starting with [VoiceInspector]
5. Test on WhatsApp Web, Teams, Discord, etc.
6. Verify Start/Stop works
7. Verify platform detection persists
```

## References

- [Manifest V3 Documentation](https://developer.chrome.com/docs/extensions/mv3/)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [WebRTC Statistics](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats)
