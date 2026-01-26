# Technology Change Flow

Ses işleme teknolojisi değiştiğinde Inspector'ı durduran mekanizma.

## Signature Yapısı

Teknoloji değişikliği 3 bileşenli bir "signature" ile tespit edilir:

| Bileşen | Olası Değerler | Açıklama |
|---------|----------------|----------|
| `processingPath` | `audioWorklet`, `scriptProcessor`, `none` | Ses işleme yöntemi |
| `encodingType` | `wasm_audioworklet`, `wasm_worker`, `browser_native` | Encoding teknolojisi |
| `outputPath` | `mediaStreamDestination`, `speakers` | Çıkış hedefi |

**Kritik:** Bu üç bileşenden **herhangi biri** değişirse → Teknoloji değişti → Inspector DURUR.

## Değişiklik Tespiti

`early-inject.js` içindeki `signatureChanged()` fonksiyonu:

```javascript
function signatureChanged(prev, current) {
  if (!prev) return false;
  return (
    prev.processingPath !== current.processingPath ||
    prev.encodingType !== current.encodingType ||
    prev.outputPath !== current.outputPath
  );
}
```

## Stop Akışı

```
early-inject.js: calculateCurrentSignature()
         ↓
signatureChanged(prev, current) → true
         ↓
broadcastSignatureChange() → postMessage(SIGNATURE_CHANGE)
         ↓
content.js: SIGNATURE_CHANGE handler
         ↓
inspectorRunning = false (SYNC - önce set!)
DISABLE_HOOKS mesajı → page.js
Queue clear (in-flight data atılır)
STOP_INSPECTOR mesajı → background.js
         ↓
background.js: stopInspector('technology_change')
  - inspectorEnabled = false
  - autoStoppedReason = 'technology_change'
  - lockedTab KORUNUR ⚠️
         ↓
popup.js:
  - showAutoStopBanner('🔄 Recording technology changed')
  - UI'da ESKİ VERİLER görünmeye devam eder
```

## Veri Koruma Davranışı

**Kritik Tasarım Kararı:** Technology change olduğunda veriler **SİLİNMEZ**.

| Storage Key | Davranış |
|-------------|----------|
| `lockedTab` | ✅ KORUNUR |
| `audio_contexts` | ✅ KORUNUR |
| `detected_encoder` | ✅ KORUNUR |
| `rtc_stats`, `audio_worklet`, vb. | ✅ KORUNUR |
| `inspectorEnabled` | ❌ Kaldırılır (stop) |
| `autoStoppedReason` | ✅ 'technology_change' olarak set edilir |

**Neden?**
- Kullanıcı eski session verilerini inceleyebilmeli
- Yeni teknoloji bilgileri **yansıtılmaz** (çünkü Inspector durmuş)
- Manual Start yapılana kadar eski veriler görünür kalır

## UI Feedback

```javascript
// popup.js - Banner mesajı
showAutoStopBanner('🔄 Recording technology changed');
```

Kullanıcı görecekleri:
1. Sarı "auto-stopped" banner'ı
2. ESKİ teknoloji/encoder bilgileri (yeni değil!)
3. Start butonu aktif (yeniden başlatabilir)

## Race Condition Prevention

Technology change akışı **3 aşamalı koruma** içerir:

1. **Sync Flag:** `inspectorRunning = false` ÖNCE set edilir
   - Queue'ya yeni veri eklenmez

2. **DISABLE_HOOKS:** page.js'e hook'ları kapatma mesajı
   - Collectors emit etmeyi durdurur

3. **Queue Clear:** Bekleyen (in-flight) veriler atılır
   - Eski teknolojinin yarım kalmış verileri temizlenir

```javascript
// content.js - SIGNATURE_CHANGE handler
case 'SIGNATURE_CHANGE':
  inspectorRunning = false;        // 1. Sync flag
  postToPage({ type: 'DISABLE_HOOKS' });  // 2. Hook'ları kapat
  pendingQueue = [];                // 3. Queue temizle
  // ... stop mesajı gönder
```

## Tetikleme Örnekleri

| Senaryo | Signature Değişimi |
|---------|-------------------|
| ScriptProcessor → AudioWorklet | `processingPath` değişir |
| WASM encoder → Browser native | `encodingType` değişir |
| Speakers → MediaStreamDestination | `outputPath` değişir |
| AudioWorklet'e WASM eklendi | `encodingType` değişir |

## İlgili Dosyalar

| Dosya | Rol |
|-------|-----|
| `scripts/early-inject.js` | Signature hesaplama, değişiklik broadcast |
| `scripts/content.js` | SIGNATURE_CHANGE handler, stop koordinasyonu |
| `scripts/background.js` | stopInspector(), autoStoppedReason kaydet |
| `scripts/popup.js` | showAutoStopBanner(), eski verileri göster |
