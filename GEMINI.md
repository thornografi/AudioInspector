# AudioInspector - Gemini Temsilci Yönergeleri

## 📁 Projeye Genel Bakış
**Adı:** AudioInspector
**Türü:** Chrome Uzantısı (Manifest V3)
**Hedef:** Teams, Discord, Zoom ve Google Meet gibi platformlarda WebRTC ses hatlarını (Codec, Bitrate, Jitter, AEC/NS/AGC) denetlemek.

## 🏗️ Mimari (Modüler)
Proje, monolitik bir betikten Kayıt Desenini kullanarak modüler bir mimariye geçirilmiştir.

### Ana Bileşenler (`/src`)
*   **Orkestratör:** `src/page/PageInspector.js`
    *   Kayıtları (Toplayıcılar, Raporlayıcılar, Dedektörler) yönetir.
    *   Yaşam döngüsünü (`initialize`, `shutdown`) ele alır.
    *   Kontrol mesajlarını (`SET_ENABLED`) dinler.
*   **Çekirdek:** `src/core/`
    *   `Registry.js`: Genel bağımlılık enjeksiyonu kapsayıcısı.
    *   `Logger.js`: Merkezi günlük kaydı hizmeti (`window.__audioPipelineLogs`).
*   **Toplayıcılar:** `src/collectors/`
    *   `RTCPeerConnectionCollector`: İstatistikler için `RTCPeerConnection`'ı bağlar.
    *   `GetUserMediaCollector`: `navigator.mediaDevices.getUserMedia`'yı bağlar.
    *   `AudioContextCollector`: `window.AudioContext`'i bağlar.
    *   `MediaRecorderCollector`: `window.MediaRecorder`'ı bağlar.
*   **Raporlayıcılar:** `src/reporters/`
    *   `ChromeStorageReporter`: `window.postMessage` aracılığıyla verileri içerik betiğine aktarır.
*   **Dedektörler:** `src/detectors/`
    *   `StandardDetectors.js`: Regex tabanlı platform algılama (Teams, Zoom vb.).

### Enjeksiyon Stratejisi
1.  **Arka Plan (`scripts/background.js`):** Uzantı Temel URL'sini + `scripts/page.js`'yi `MAIN` dünyasına enjekte eder.
2.  **Yükleyici (`scripts/page.js`):** `src/page/PageInspector.js`'yi dinamik olarak `import` etmek için Temel URL'yi kullanır.
3.  **Köprü (`scripts/content.js`):** `MAIN` dünyası (sayfa) ile Uzantı (açılır pencere/arka plan) arasındaki mesajları aktarır.

## 🛠️ Geliştirme İş Akışı

### Dosya Konumları
*   **Kaynak Mantığı:** `src/**/*.js` (ES Modülleri)
*   **Giriş Noktaları:** `scripts/*.js` (Chrome Uzantı Bağlamları)
*   **Kullanıcı Arayüzü:** `views/popup.html`, `scripts/popup.js`
*   **Manifest:** `manifest.json`

### Kurallar
*   **Kod Stili:** Modern ES6+, JSDoc gerekli (`// @ts-check`).
*   **Günlük Kaydı:** `src/core/Logger.js` kullanın (`logger.info`, `logger.error`). **Doğrudan `console.log` kullanmayın.**
*   **İzinler:** Dinamik içe aktarmalara izin vermek için `manifest.json`'da `web_accessible_resources` için `src/**/*.js` bulunmalıdır.

### Derleme/Test
*   **Derleme Adımı Yok:** Proje yerel ES Modülleri kullanır.
*   **Kurulum:** Klasörü Chrome'da "Paketlenmemiş Uzantı" olarak yükleyin.
*   **Test Etme:** Uzantıyı yükledikten sonra WebRTC olaylarını simüle etmek için Chrome'da `tests/test.html` dosyasını açın.

## 🔄 Son Geçiş Notları (Ocak 2026)
*   **Monolitten Modülere:** `scripts/page.js`'deki eski IIFE korunmuştur ancak `USE_NEW_ARCHITECTURE` bayrağı (`true` olarak ayarlanmıştır) aracılığıyla devre dışı bırakılmıştır.
*   **Günlük Kaydı Yeniden Düzenlemesi:** `PageInspector`'daki tüm doğrudan konsol günlükleri `Logger` sınıfı ile değiştirilmiştir.
*   **Kontrol Akışı:** `SET_ENABLED` mesajı artık tüm toplayıcıları Kayıt defteri aracılığıyla düzgün bir şekilde başlatır/durdurur.

## 🤖 Gemini'ye Özel Hafıza
*   **Araç Kullanımı:** Yeni toplayıcılar eklemeden önce mevcut toplayıcıların uygulamasını anlamak için `read_file`'ı tercih edin.
*   **Değişiklik:** `src/` dosyalarını değiştirirken, bunların uygun şekilde dışa aktarıldığından ve ilgili `index.js` dosyalarına kaydedildiğinden emin olun.

---

**NOT:** Gemini, lütfen bana her zaman Türkçe yanıt ver.