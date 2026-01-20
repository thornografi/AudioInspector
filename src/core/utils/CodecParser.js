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
      encoder: 'opus-recorder',
      type: 'lossy',
      typical_bitrate: '6-510 kbps',
      latency: 'low (2.5-60ms)',
      features: ['VBR', 'CBR', 'FEC', 'DTX', 'stereo']
    },
    mp3: {
      name: 'MP3',
      encoder: 'lamejs',
      type: 'lossy',
      typical_bitrate: '128-320 kbps',
      latency: 'medium',
      features: ['VBR', 'CBR', 'joint stereo']
    },
    aac: {
      name: 'AAC',
      encoder: 'fdk-aac.js',
      type: 'lossy',
      typical_bitrate: '96-320 kbps',
      latency: 'medium',
      features: ['VBR', 'CBR', 'HE-AAC', 'AAC-LC']
    },
    pcm: {
      name: 'PCM (Uncompressed)',
      encoder: null,
      type: 'lossless',
      typical_bitrate: '1411 kbps (CD quality)',
      latency: 'none',
      features: ['uncompressed']
    },
    vorbis: {
      name: 'Vorbis',
      encoder: 'vorbis.js',
      type: 'lossy',
      typical_bitrate: '64-500 kbps',
      latency: 'medium',
      features: ['VBR']
    },
    flac: {
      name: 'FLAC',
      encoder: 'libflac.js',
      type: 'lossless',
      typical_bitrate: '~1000 kbps',
      latency: 'low',
      features: ['lossless compression']
    }
  };

  if (!codec) return null;
  return codecDb[codec.toLowerCase()] || { name: codec, encoder: null, type: 'unknown' };
}

/**
 * Worker URL veya dosya adından encoder tespit eder
 * @param {string|null} url - Worker URL veya dosya adı
 * @param {string|null} codec - Bilinen codec (varsa)
 * @returns {{encoder: string|null, codec: string|null}} Tespit edilen encoder ve codec
 */
export function detectEncoder(url, codec = null) {
  if (!url) {
    // Codec'den varsayılan encoder
    if (codec) {
      const info = getCodecInfo(codec);
      return { encoder: info?.encoder || null, codec };
    }
    return { encoder: null, codec: null };
  }

  const urlLower = url.toLowerCase();

  // lamejs MP3 encoder patterns
  if (urlLower.includes('lame') || urlLower.includes('lamejs') || urlLower.includes('mp3encoder')) {
    return { encoder: 'lamejs', codec: 'mp3' };
  }

  // opus-recorder patterns
  if (urlLower.includes('opus') || urlLower.includes('libopus')) {
    return { encoder: 'opus-recorder', codec: 'opus' };
  }

  // fdk-aac.js patterns
  if (urlLower.includes('fdk') || urlLower.includes('fdkaac') || urlLower.includes('aacencoder')) {
    return { encoder: 'fdk-aac.js', codec: 'aac' };
  }

  // vorbis.js patterns
  if (urlLower.includes('vorbis') || urlLower.includes('libvorbis') || urlLower.includes('oggencoder')) {
    return { encoder: 'vorbis.js', codec: 'vorbis' };
  }

  // libflac.js patterns
  if (urlLower.includes('flac') || urlLower.includes('libflac')) {
    return { encoder: 'libflac.js', codec: 'flac' };
  }

  // Codec'den varsayılan encoder
  if (codec) {
    const info = getCodecInfo(codec);
    return { encoder: info?.encoder || null, codec };
  }

  return { encoder: null, codec: null };
}
