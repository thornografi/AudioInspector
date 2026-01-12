# AudioInspector - Skill Routing Table

Bu dosya Claude Code'un skill routing sistemi için gereklidir.

## Kayıtlı Skill'ler

| Skill | Amaç | Tetikleyici Kelimeler |
|-------|------|----------------------|
| **architecture** | Extension mimarisi, script türleri, veri akışı | mimari, architecture, manifest, content script, background, page script, main world, isolated world, postMessage, veri akışı |
| **collectors** | Collector yazma, API hooking, veri toplama | collector, hook, rtcpeerconnection, getusermedia, audiocontext, mediarecorder, polling, getstats, emit, yeni collector |

## Skill Dosya Yapısı

```
.claude/
├── AGENTS.md          # Bu dosya (routing table)
├── README.md          # Skill index
├── settings.json      # Skill kayıtları
└── skills/
    ├── architecture/
    │   └── SKILL.md
    └── collectors/
        └── SKILL.md
```

## Detaylı Bilgi

Her skill için detaylı dokümantasyon: `.claude/skills/[skill-name]/SKILL.md`

Skill kullanım örnekleri: `.claude/README.md`
