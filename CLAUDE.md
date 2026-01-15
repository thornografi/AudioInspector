# AudioInspector - Proje Rehberi

## Klasör Yapısı

```
audio-inspector/
├── .claude/              # Claude Code yapılandırma ve skill'ler
│   ├── settings.json     # Skill kayıtları
│   ├── README.md         # Skill dizini
│   └── skills/           # Özel skill'ler
│       ├── architecture/SKILL.md
│       └── collectors/SKILL.md
│
├── src/                  # Modüler uygulama kodu
│   ├── core/             # Yardımcılar ve sabitler
│   │   ├── utils/
│   │   │   ├── ApiHook.js      # API hooking yardımcısı
│   │   │   ├── CodecParser.js  # Codec ayrıştırma
│   │   │   └── EarlyHook.js    # Erken hook mekanizması
│   │   ├── Logger.js           # Merkezi loglama
│   │   └── constants.js        # Sabitler
│   ├── collectors/       # Veri toplama modülleri
│   │   ├── BaseCollector.js
│   │   ├── PollingCollector.js
│   │   ├── RTCPeerConnectionCollector.js
│   │   ├── GetUserMediaCollector.js
│   │   ├── AudioContextCollector.js
│   │   └── MediaRecorderCollector.js
│   ├── detectors/        # Platform algılama
│   │   ├── BaseDetector.js
│   │   ├── RegexDetector.js
│   │   └── platforms/
│   │       └── StandardDetectors.js
│   └── page/             # Ana orkestratör
│       └── PageInspector.js
│
├── scripts/              # Extension script dosyaları
│   ├── background.js     # Service worker (Manifest V3)
│   ├── content.js        # Content script (ISOLATED world)
│   ├── page.js           # Page script (MAIN world - hook'lar ve API'ler)
│   └── popup.js          # Popup UI mantığı
│
├── views/                # HTML şablonları
│   └── popup.html        # Popup arayüzü
│
├── images/               # İkonlar ve görsel varlıklar
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
│
├── tests/                # Test dosyaları
│   ├── test.html
│   └── ui-test.html
│
├── manifest.json         # Extension manifest (Manifest V3)
├── AGENTS.md             # Agent rehberi
└── CLAUDE.md             # Bu dosya (proje rehberi)
```

## Dosya Amaçları

### Extension Script'leri (`/scripts`)
- **background.js** - Service worker, API enjeksiyonu, olay yönetimi
- **content.js** - Content script köprüsü (ISOLATED world), mesaj aktarımı
- **page.js** - Page script (MAIN world), WebRTC API hook'ları, veri toplama
- **popup.js** - Popup UI mantığı, durum yönetimi, olay işleyicileri

### Görünümler ve Varlıklar (`/views`, `/images`)
- **popup.html** - Extension popup şablonu
- **icon*.png** - Extension ikonları (16x16, 48x48, 128x128)

### Çekirdek Uygulama (`/src`)
- **PageInspector** - Ana orkestratör. Collector'ları başlatır ve `postMessage` ile doğrudan raporlama yapar.
- **Collectors** - API hook'ları (RTCPeerConnection, getUserMedia, AudioContext, MediaRecorder)
- **Detectors** - Platform algılama (Teams, Discord, Zoom, vb.)

## Mimari Genel Bakış

### Extension Yaşam Döngüsü

```
Kullanıcı extension'ı yükler
         ↓
manifest.json script'leri yükler
         ↓
background.js (Service Worker) başlar
         ↓
content.js enjekte eder → page.js (MAIN world)
         ↓
page.js, PageInspector aracılığıyla WebRTC API'lerini hook'lar
         ↓
Collector'lar veri üretir → PageInspector
         ↓
PageInspector → window.postMessage()
         ↓
content.js alır → chrome.storage.local
         ↓
popup.js okur → UI'ı günceller
```

### Veri Akışı

```
[MAIN world - page.js / PageInspector]
  RTCPeerConnection, getUserMedia, AudioContext hook'ları
         ↓
  PageInspector._report() → window.postMessage()
         ↓
[ISOLATED world - content.js]
  postMessage dinleyicisi → chrome.storage.local.set()
         ↓
[Popup bağlamı - popup.js]
  chrome.storage.local.get() → updateUI()
         ↓
[UI - popup.html]
  WebRTC istatistikleri, inspector durumu (Başladı/Durdu), kontroller
```

### Durum Yönetimi

- **inspectorEnabled** (chrome.storage.local) - Inspector aktif mi?
- **lockedTab** (chrome.storage.local) - Kilitli tab bilgisi: `{ id, url, title }`
- **platformInfo** (chrome.storage.local) - Platform algılama (kalıcı)
- **audioData** (chrome.storage.local) - Son istatistik verileri
- **debug_logs** (chrome.storage.local) - Merkezi log kayıtları

### Kontrol Mesajları

**page.js → content.js** (Başlatma)
- `INSPECTOR_READY` - PageInspector komutlara hazır olduğunu bildirir (race condition düzeltmesi)

**popup.js → content.js → page.js** (Kullanıcı eylemleri)
- `SET_ENABLED` - İstatistik toplamayı aç/kapat
- `FORCE_REFRESH` - Anlık istatistik toplama

**content.js → background.js** (Tab ve Log yönetimi)
- `GET_TAB_ID` - Content script kendi tab ID'sini öğrenir (tab kilitleme için)
- `ADD_LOG` - Merkezi log ekleme (race condition önleme)

**content.js → page.js** (Durum geri yükleme)
- `SET_ENABLED` - INSPECTOR_READY sinyalinden sonra inspector durumunu geri yükle (tab ID + origin kontrolü ile)
- `RE_EMIT_ALL` - Collector'lara mevcut verileri yeniden göndermelerini söyle (yeni kayıtta storage sıfırlandıktan sonra)

## Skill Yönlendirme

İki özel skill mevcut (`.claude/skills/`):

| Skill | Amaç | Tetikleyici Kelimeler |
|-------|------|----------------------|
| **architecture** | Extension mimarisi, script türleri, veri akışı | mimari, architecture, manifest, content script, background, page script, main world, isolated world, postMessage, veri akışı |
| **collectors** | Collector yazma, API hooking, veri toplama | collector, hook, rtcpeerconnection, getusermedia, audiocontext, mediarecorder, polling, getstats, emit, yeni collector |

Detaylı bilgi: `.claude/README.md`

## Kod Yazma Kuralları

> **Temel İlke:** Aşağıdaki tüm kurallar "aşırı mühendislikten kaçınarak" uygulanmalıdır. Hedef, basitlik ile genişletilebilirlik arasındaki optimal dengeyi bulmaktır.

### 🔄 DRY (Kendini Tekrarlama)
1. **Yeni kod yazmadan önce mevcut yardımcıları kontrol et**
   - CSS: `popup.html` → `.has-tooltip`, `.subheader`, `.sub-item`, CSS değişkenleri
   - JS: `src/core/utils/ApiHook.js`, `src/core/constants.js`
2. **Tekrar eden değerler → constants.js veya CSS değişkeni**
3. **Benzer fonksiyonlar → tek parametrik fonksiyon** (ama gerçekten gerekiyorsa)

### 🔓 OCP (Açık-Kapalı Prensibi)
4. **Genişlemeye açık, değişikliğe kapalı yaz** (sadece genişleme öngörülüyorsa)
   - `data-attribute` > sabit içerik (bkz: `.has-tooltip`)
   - Config nesnesi > çoklu if-else (karmaşıklık makul olduğunda)
   - Factory fonksiyon > tekrarlı constructor
5. **Yeni özellik = yeni kod** (ama önce mevcut kodu genişletmeyi düşün)

### 🧬 Kalıtım ve Bileşim
6. **Mevcut base class varsa türet**
   - Collector → `BaseCollector` veya `PollingCollector`
   - Detector → `BaseDetector` veya `RegexDetector`
7. **Pattern'leri takip et** - Benzer kod nasıl yazılmış?
8. **Bileşim > derin kalıtım** - 2 seviyeden fazla türetme yapma

### ⚖️ YAGNI (Şimdi Gerekmiyorsa Ekleme)
9. **3 satır tekrar > 1 gereksiz soyutlama**
10. **Gelecek için değil, şimdi için yaz** - Varsayımsal gereksinimler için tasarlama

## Geliştirme Rehberi

### Yeni Collector Ekleme

1. Yeni dosya oluştur: `src/collectors/MyCollector.js`
2. `src/collectors/BaseCollector.js` veya `PollingCollector.js`'den türet
3. `initialize()`, `start()`, `stop()` metodlarını uygula
4. `src/page/PageInspector.js` başlatma listesine ekle

Detaylı rehber: **collectors** skill'i

### Yeni Detector Ekleme

1. Detector tanımını `src/detectors/platforms/StandardDetectors.js`'e ekle

### Dosya Yolu Kuralları

- Manifest'te referans verilen dosyalar `/scripts` içinde OLMALI
- HTML şablonları `/views` içinde OLMALI
- İkonlar `/images` içinde OLMALI
- Modüler kod `/src` içinde OLMALI
- Test dosyaları `/tests` içinde OLMALI

### Önemli Notlar

- manifest.json'u değiştirmeden önce bu rehberdeki dosya yollarını güncelle
- MAIN world enjeksiyonu (page.js) Chrome extension API izinleri gerektirir
- Content script ISOLATED'dır - sayfa değişkenlerine doğrudan erişemez
- Platform bilgisi storage temizlemelerinde korunur (popup.js tarafından saklanır)
- İstatistik yoklama extension etkin durumuna göre kontrol edilir

## Test

Yeniden yapılandırma veya özellik ekledikten sonra:

```bash
1. chrome://extensions/ aç
2. AudioInspector'da yeniden yükle'ye tıkla
3. DevTools (F12) → Console aç
4. [AudioInspector] ile başlayan hataları kontrol et
5. WhatsApp Web, Teams, Discord, vb. üzerinde test et
6. Başlat/Durdur'un çalıştığını doğrula
7. Platform algılamanın kalıcı olduğunu doğrula
```
