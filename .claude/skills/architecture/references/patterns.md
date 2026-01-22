# Storage & Async Patterns

Storage yönetimi ve asenkron işlem pattern'leri.

## storage.onChanged Listener Pattern

Polling yerine reactive pattern. **popup.js**'de kullanılır:

```javascript
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  // DATA_STORAGE_KEYS değiştiyse UI güncelle
  const shouldUpdate = Object.keys(changes).some(key => DATA_STORAGE_KEYS.includes(key));
  if (shouldUpdate) {
    updateUI();
    if (changes.inspectorEnabled) {
      enabled = changes.inspectorEnabled.newValue === true;
      updateToggleButton();
    }
    checkTabLock();
  }

  // lockedTab kaldırıldıysa state sıfırla
  if (changes.lockedTab && !changes.lockedTab.newValue) {
    enabled = false;
    updateToggleButton();
    checkTabLock();
  }
});
```

**Dikkat:** Storage set eden fonksiyonlarda manuel `checkTabLock()` veya `updateUI()` çağırmayın - listener zaten handle eder (duplicate tetikleme riski).

## Async Storage Clearing (Race Condition Fix)

**Problem:** `storage.remove()` callback pattern kullanıyordu ama await edilmiyordu. Collectors emit ettiği yeni veri eski veriyle karışıyordu.

**Çözüm:** Promise wrapper ile await:

```javascript
// content.js - handleSetEnabled()
async function handleSetEnabled(message) {
  await chrome.storage.local.set({ inspectorEnabled: message.enabled });

  if (message.enabled) {
    // AWAIT completion - kritik!
    await new Promise(resolve => {
      clearMeasurementData(() => {
        logContent('🧹 Cleared stale data from storage');
        resolve();
      });
    });
  }

  // Storage temizlendikten SONRA page.js'e gönder
  window.postMessage({
    __audioPipelineInspector: true,
    type: 'SET_ENABLED',
    enabled: message.enabled
  }, '*');
}
```

**Key Points:**
- ✅ Promise wrapper makes storage.remove() awaitable
- ✅ `return true` keeps message channel open for async sendResponse
- ✅ Storage fully cleared BEFORE collectors start emitting

## Force Restart Logic

**Problem:** STOP message kaybolursa state `enabled=true` kalır, restart engellenir.

**Çözüm:** PageInspector'da state mismatch kontrolü:

```javascript
// PageInspector.js - _setupControlListener()
if (event.data.type === 'SET_ENABLED') {
  const enabled = event.data.enabled;

  // Already enabled + trying to enable → force restart
  if (this.inspectorEnabled === enabled && enabled === true) {
    logger.info(LOG_PREFIX.INSPECTOR, `Already enabled, forcing collector restart`);
    await this._stopAllCollectors();
  }

  // Already disabled + trying to disable → skip
  if (this.inspectorEnabled === enabled && enabled === false) {
    return;
  }

  this.inspectorEnabled = enabled;
  if (enabled) {
    logger.setEnabled(true);
    await this._startAllCollectors();
  } else {
    await this._stopAllCollectors();
    logger.setEnabled(false);
  }
}
```

## Clean Slate Approach

Start'ta TÜM önceki state temizlenir - stale data önlenir.

**Davranış:**
- **Stop:** Veriler korunur (geçmiş kayıt olarak review için)
- **Start:** Sıfırdan başla (fresh start)

**Neden Gerekli:**
- Tab switch sonrası eski encoding verisi görünmemeli
- Stop sonrası veriler "geçmiş kayıt" olarak kalır

**AudioContextCollector.start() temizlik:**
1. `activeContexts.clear()` + `contextIdCounter = 0`
2. `cleanupClosedAudioContexts()` - EarlyHook registry temizle
3. `__detectedEncoderHandler` yeniden kaydet
4. `__detectedEncoderData = null`
5. Sadece `state !== 'closed'` context'leri sync et

## Constants Management (DRY Pattern)

popup.js, content.js, background.js ES module olmadığı için `constants.js`'den import edemez.

### DATA_STORAGE_KEYS - Message-Based Pattern

**SINGLE SOURCE OF TRUTH:** `scripts/background.js`

```javascript
// background.js - Tek doğru kaynak
const DATA_STORAGE_KEYS = [
  'rtc_stats', 'user_media', 'audio_contexts', 'audio_worklet',
  'media_recorder', 'detected_encoder', 'audio_connections', 'recording_active'
];
```

**Diğer script'ler message ile alır:**
```javascript
// content.js / popup.js - Başlangıçta fallback, sonra güncelleme
let DATA_STORAGE_KEYS = ['rtc_stats', ...]; // fallback

chrome.runtime.sendMessage({ type: 'GET_STORAGE_KEYS' }, (response) => {
  if (response?.keys) {
    DATA_STORAGE_KEYS = response.keys;
  }
});
```

**✅ Avantaj:** Yeni key eklerken sadece background.js'i güncelle!

### clearInspectorData - Centralized Pattern

**SINGLE SOURCE OF TRUTH:** `scripts/background.js`

```javascript
// background.js - Merkezi fonksiyon
function clearInspectorData(options = {}) {
  const { includeAutoStopReason = false, includeLogs = true, dataOnly = false } = options;
  // ... keys hesapla ve sil
}
```

**Diğer script'ler message ile çağırır:**
```javascript
// content.js / popup.js
chrome.runtime.sendMessage({
  type: 'CLEAR_INSPECTOR_DATA',
  options: { dataOnly: true }  // veya { includeLogs: false }
}, callback);
```

**Options:**
| Option | Varsayılan | Açıklama |
|--------|------------|----------|
| `dataOnly` | false | Sadece ölçüm verileri (state korunur) |
| `includeLogs` | true | debug_logs dahil mi |
| `includeAutoStopReason` | false | autoStoppedReason dahil mi |

### Diğer Duplicate Sabitler (popup.js only)

```javascript
const DESTINATION_TYPES = { SPEAKERS: 'speakers', MEDIA_STREAM: 'MediaStreamDestination' };
const MAX_AUDIO_CONTEXTS = 4; // UI limit
```

Bu sabitler sadece popup.js'de kullanıldığından inline kalabilir.

## ENCODER_KEYWORDS (Codec Detection)

WASM encoder tespiti için Worker URL'lerinde aranan keyword'ler.

**SINGLE SOURCE OF TRUTH:** `src/core/constants.js`

```javascript
export const ENCODER_KEYWORDS = [
  'encoder', 'opus', 'ogg', 'mp3', 'aac', 'vorbis', 'flac',
  'lame', 'audio', 'media', 'wasm', 'codec', 'voice', 'recorder'
];
```

**Import eden dosyalar:**
- `src/core/utils/EarlyHook.js` → `import { ENCODER_KEYWORDS } from '../constants.js'`
- `src/collectors/AudioContextCollector.js` → `import { ENCODER_KEYWORDS } from '../core/constants.js'`

**Inline kopya (sync gerekli):**
- `scripts/early-inject.js` → `ENCODER_KEYWORDS` (ES module değil, inline kopya)

**Kullanım:** Worker URL veya filename encoder keyword içeriyorsa, o Worker audio encoding için kullanılıyor olabilir:

```javascript
const hasEncoderKeyword = ENCODER_KEYWORDS.some(kw =>
  workerFilename.toLowerCase().includes(kw)
);
```

**⚠️ Senkronizasyon:** Yeni codec/library eklendiğinde TÜM kopyaları güncelle!
