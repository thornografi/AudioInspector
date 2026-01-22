// @ts-check

/**
 * Opus SDP fmtp parametrelerini parse eder
 * Örnek input: "minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;cbr=0"
 *
 * @param {string|null|undefined} sdpFmtpLine - SDP fmtp satırı
 * @returns {Object} Parse edilmiş Opus parametreleri
 */
export function parseOpusParams(sdpFmtpLine) {
  const params = {
    // Temel parametreler
    minptime: null,        // Minimum paket süresi (ms)
    maxptime: null,        // Maximum paket süresi (ms)
    ptime: null,           // Tercih edilen paket süresi (ms)

    // Stereo/Mono
    stereo: null,          // 0=mono, 1=stereo
    spropStereo: null,     // Gönderen stereo tercihi

    // Bitrate kontrolü
    cbr: null,             // 0=VBR, 1=CBR (Constant Bit Rate)
    maxaveragebitrate: null, // Max ortalama bitrate (bps)

    // Hata düzeltme
    useinbandfec: null,    // 0=kapalı, 1=açık (Forward Error Correction)
    usedtx: null,          // 0=kapalı, 1=açık (Discontinuous Transmission)

    // Ham değer
    raw: sdpFmtpLine || null
  };

  if (!sdpFmtpLine) return params;

  // Parse key=value pairs
  const pairs = sdpFmtpLine.split(';');
  for (const pair of pairs) {
    const [key, value] = pair.trim().split('=');
    if (!key || value === undefined) continue;

    const numValue = parseInt(value, 10);

    switch (key.toLowerCase()) {
      case 'minptime':
        params.minptime = numValue;
        break;
      case 'maxptime':
        params.maxptime = numValue;
        break;
      case 'ptime':
        params.ptime = numValue;
        break;
      case 'stereo':
        params.stereo = numValue === 1;
        break;
      case 'sprop-stereo':
        params.spropStereo = numValue === 1;
        break;
      case 'cbr':
        params.cbr = numValue === 1;
        break;
      case 'maxaveragebitrate':
        params.maxaveragebitrate = numValue;
        break;
      case 'useinbandfec':
        params.useinbandfec = numValue === 1;
        break;
      case 'usedtx':
        params.usedtx = numValue === 1;
        break;
    }
  }

  return params;
}

/**
 * MediaRecorder veya codec mimeType'ını parse eder
 * Örnek: "audio/webm;codecs=opus" -> { container: 'webm', codec: 'opus' }
 * Örnek: "audio/opus" -> { container: null, codec: 'opus' }
 *
 * @param {string|null|undefined} mimeType - MIME type string
 * @returns {Object} Parse edilmiş codec bilgisi
 */
export function parseMimeType(mimeType) {
  const result = {
    type: null,        // 'audio' veya 'video'
    container: null,   // 'webm', 'ogg', 'mp4' vb.
    codec: null,       // 'opus', 'aac', 'pcm' vb.
    raw: mimeType || null
  };

  if (!mimeType) return result;

  // "audio/webm;codecs=opus" formatı
  const [typeContainer, codecPart] = mimeType.split(';');

  if (typeContainer) {
    const [type, container] = typeContainer.split('/');
    result.type = type || null;

    // Container veya doğrudan codec olabilir
    if (container) {
      // "opus", "pcm" gibi doğrudan codec isimleri
      const directCodecs = ['opus', 'pcm', 'aac', 'mp3', 'flac', 'vorbis'];
      if (directCodecs.includes(container.toLowerCase())) {
        result.codec = container.toLowerCase();
      } else {
        result.container = container.toLowerCase();
      }
    }
  }

  // codecs= parametresi
  if (codecPart) {
    const codecMatch = codecPart.match(/codecs?=["']?([^"',]+)/i);
    if (codecMatch) {
      result.codec = codecMatch[1].toLowerCase();
    }
  }

  return result;
}

/**
 * Codec tipine göre ek bilgi döner
 * @param {string|null} codec - Codec adı
 * @returns {Object} Codec hakkında ek bilgi
 */
export function getCodecInfo(codec) {
  const codecDb = {
    opus: {
      name: 'Opus',
      encoder: 'opus-wasm',  // Generic encoder type
      library: 'libopus',    // Underlying C library
      type: 'lossy',
      typical_bitrate: '6-510 kbps',
      latency: 'low (2.5-60ms)',
      features: ['VBR', 'CBR', 'FEC', 'DTX', 'stereo']
    },
    mp3: {
      name: 'MP3',
      encoder: 'mp3-wasm',
      library: 'LAME',
      type: 'lossy',
      typical_bitrate: '128-320 kbps',
      latency: 'medium',
      features: ['VBR', 'CBR', 'joint stereo']
    },
    aac: {
      name: 'AAC',
      encoder: 'aac-wasm',
      library: 'FDK AAC',
      type: 'lossy',
      typical_bitrate: '96-320 kbps',
      latency: 'medium',
      features: ['VBR', 'CBR', 'HE-AAC', 'AAC-LC']
    },
    pcm: {
      name: 'PCM (Uncompressed)',
      encoder: 'pcm',
      library: null,
      type: 'lossless',
      typical_bitrate: '1411 kbps (CD quality)',
      latency: 'none',
      features: ['uncompressed']
    },
    vorbis: {
      name: 'Vorbis',
      encoder: 'vorbis-wasm',
      library: 'libvorbis',
      type: 'lossy',
      typical_bitrate: '64-500 kbps',
      latency: 'medium',
      features: ['VBR']
    },
    flac: {
      name: 'FLAC',
      encoder: 'flac-wasm',
      library: 'libFLAC',
      type: 'lossless',
      typical_bitrate: '~1000 kbps',
      latency: 'low',
      features: ['lossless compression']
    }
  };

  if (!codec) return null;
  return codecDb[codec.toLowerCase()] || { name: codec, encoder: null, library: null, type: 'unknown' };
}
// NOTE: detectEncoder() function removed - unused code (DRY principle)
// Encoder/library detection is handled by EarlyHook.js (getEncoderTypeForWorker, detectLibraryFromWorker)
