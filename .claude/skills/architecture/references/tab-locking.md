# Tab Locking

Inspector sadece tek tab'da çalışır. Tab kilitleme mekanizması.

## Storage Keys

- `lockedTab: { id, url, title }` - Kilitli tab bilgisi
- `inspectorEnabled: boolean` - Inspector durumu
- `pendingAutoStart: number` - Tab ID (refresh sonrası auto-start)

## Kilitleme Akışı

```
[popup.js] Start butonuna basıldı
       ↓
lockedTab = { id: activeTab.id, url, title }
chrome.storage.local.set({ inspectorEnabled: true, lockedTab })
       ↓
[content.js] INSPECTOR_READY geldiğinde:
  1. currentTabId injection response'dan alınmış
  2. Tab ID kontrolü: currentTabId === lockedTab.id?
  3. Origin kontrolü: currentOrigin === lockedOrigin?
  4. Her ikisi eşleşirse → SET_ENABLED: true
```

## Farklı Tab'dan Stop

```
[popup.js] Farklı tab'dayken Stop basıldı
       ↓
lockedTab.id'ye mesaj gönder (aktif tab'a değil!)
       ↓
[content.js @ locked tab] SET_ENABLED: false alır
```

## Second Start Refresh Modal

Aynı tab'da ikinci kez Start'a basıldığında stale data önlemek için sayfa yenileme zorunlu.

**Problem:** Kullanıcı aynı sayfada:
1. Ses kaydı yaptı (AudioContext + WASM encoder)
2. Inspector'ı durdurdu
3. Ayarları değiştirip tekrar kayıt başlattı
4. Eski encoder verisi hala görünüyor!

**Çözüm:**

```
[popup.js - toggleInspector()]
       ↓
!enabled && lockedTab && lockedTab.id === activeTab.id?
       ↓
  ├─ Hayır → Normal START
  └─ Evet → showRefreshModal()
              ├─ [İptal] → Modal kapanır
              └─ [Yenile ve Başlat] → handleRefreshAndStart()
                    1. clearInspectorData()
                    2. pendingAutoStart = tabId
                    3. chrome.tabs.reload(tabId)
```

## pendingAutoStart Flow

```
[popup.js] Yenile ve Başlat
       ↓
pendingAutoStart = tabId
       ↓
chrome.tabs.reload(tabId)
       ↓
[Sayfa yenileniyor...]
       ↓
[content.js] INSPECTOR_READY
       ↓
pendingAutoStart === currentTabId?
       ↓
Evet → Auto-start:
  1. pendingAutoStart temizle
  2. lockedTab set et
  3. SET_ENABLED: true gönder
```

## Modal Tetiklenme Koşulları

| Senaryo | lockedTab | Modal |
|---------|-----------|-------|
| Same tab + second start | VAR | ✅ ÇIKAR |
| Tab switch sonrası aynı tab'a dön | VAR | ✅ ÇIKAR |
| Origin change sonrası | SİLİNİR | ❌ ÇIKMAZ |
| Tab kapatılınca | SİLİNİR | ❌ ÇIKMAZ |
| Farklı tab'da Start | VAR (eski) | ❌ ÇIKMAZ |
| Clear Data sonrası | SİLİNİR | ❌ ÇIKMAZ |

## Popup Tab Listeners

**currentTabId Senkronizasyonu:**

```javascript
let currentTabId = null;

// İlk yükleme
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
currentTabId = tab?.id;

// Tab değişikliğinde sync - KRİTİK
chrome.tabs.onActivated.addListener((activeInfo) => {
  currentTabId = activeInfo.tabId;
  checkTabLock();
});
```

**URL Navigation Detection:**

System sayfasından web sayfasına geçişte kontrollerin aktif olması:

```javascript
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && tabId === currentTabId) {
    checkTabLock();
  }
});
```

**Edge Case:** chrome://newtab'dan recorder sitesine gidiş → `tabs.onUpdated` → `checkTabLock()` → Start aktif olur.
