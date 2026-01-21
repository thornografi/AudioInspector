# AudioInspector Terminoloji Notları

Bu doküman, UI’da görünen terimlerin ne anlama geldiğini ve hangi bilginin “kullanıcı-dostu”, hangisinin “teknik kanıt” olarak ele alınması gerektiğini tanımlar.

## Encoding (Kodlama)

- `Codec`: Çıktı ses codec’i (ör. `OPUS`, `MP3`, `PCM`).
- `Container`: Dosya/kapsayıcı formatı (ör. `OGG`, `WEBM`, `WAV`). Codec ile aynı şey değildir.
- `Encoder`: Kodlamayı yapan kütüphane/engine adı (ör. `opus-recorder`, `MediaRecorder API`, `WebRTC Native`). Her akışta görünmek zorunda değildir (PCM/WAV gibi durumlarda “encoder” kavramı anlamsız olabilir).
- `Confidence`: Tespitin yöntem/kalite etiketi (örn. Worker hook, AudioWorklet init, Blob post-hoc).

## Audio Path / Audio Graph

- `Processor`: Audio graph içindeki işlemci düğümleri (ScriptProcessor, AudioWorklet, Gain, Analyser vb.).
- `Format`: Henüz codec tespiti yoksa veya ham PCM akışıysa kullanıcıya “Raw PCM / Linear PCM (WAV)” gibi açıklayıcı gösterim.

## UI İlkeleri

1. Ana tabloda “anlam”: kullanıcıya codec/container/encoder gibi kavramlar gösterilir.
2. Tooltip’te “kanıt”: worker dosya adı, worklet processor adı, module URL gibi teknik detaylar gösterilir (UI metninde görünmez).
3. Aynı kavram iki kez aynı etiketle gösterilmez (örn. iki `Encoder` satırı).
