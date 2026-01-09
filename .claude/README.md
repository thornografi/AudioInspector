# VoiceInspector - Skill'ler

Bu proje için özel Claude Code skill'leri.

## Skill Listesi

| Skill | Amaç | Anahtar Kelimeler |
|-------|------|-------------------|
| **architecture** | Extension mimarisi, script türleri, veri akışı | mimari, manifest, content script, page script, main world, postMessage |
| **collectors** | Collector yazma, API hooking | collector, hook, rtcpeerconnection, getusermedia, audiocontext, emit |
| **skill-controller** | Skill denetimi ve validasyonu | skill audit, skill kontrol, senkronizasyon |

## Kullanım Örnekleri

```
✅ "MAIN world injection nasıl çalışıyor?"  → architecture
✅ "Yeni collector nasıl yazılır?"          → collectors
✅ "RTCPeerConnection hook örneği"          → collectors
✅ "Skill audit yap"                        → skill-controller
```

## Klasör Yapısı

```
.claude/
├── settings.json      # Skill kayıtları
├── README.md          # Bu dosya
└── skills/
    ├── architecture/SKILL.md
    ├── collectors/SKILL.md
    └── skill-controller/SKILL.md
```
