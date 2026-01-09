// @ts-check

import { logger } from '../core/Logger.js';
import PollingCollector from './PollingCollector.js';
import { EVENTS, DATA_TYPES } from '../core/constants.js';
import { parseOpusParams } from '../core/utils/CodecParser.js';
import { getInstanceRegistry } from '../core/utils/EarlyHook.js';

/**
 * Collects WebRTC RTCPeerConnection stats (codec, bitrate, jitter, packet loss, etc.)
 * Hooks into RTCPeerConnection constructor and periodically polls for stats.
 */
class RTCPeerConnectionCollector extends PollingCollector {
  /**
   * @param {Object} [options={}] - Collector options
   * @param {number} [options.pollIntervalMs=1000] - Stats polling interval in milliseconds
   */
  constructor(options = {}) {
    super('rtc-peer-connection', options);

    /** @type {Set<RTCPeerConnection>} */
    this.peerConnections = new Set();

    /** @type {Function|null} */
    this.originalRTCPeerConnection = null;

    /** @type {Map<RTCPeerConnection, {bytesSent: number, bytesReceived: number, timestamp: number}>} */
    this.previousStats = new Map();
  }

  /**
   * Initialize collector - hook RTCPeerConnection constructor
   * NOTE: Early hooks (EarlyHook.js) already installed RTCPeerConnection Proxy.
   * We skip hookConstructor here to avoid overwriting the early Proxy.
   * @returns {Promise<void>}
   */
  async initialize() {
    // Register global handler IMMEDIATELY (even before start)
    // @ts-ignore
    window.__rtcPeerConnectionCollectorHandler = (pc) => {
      this._handleNewConnection(pc);
    };

    // Early hooks already installed constructor hooks, so we skip hookConstructor here
    logger.info(this.logPrefix, 'Skipping constructor hook (early hook already installed)');
  }

  /**
   * Handle new peer connection instance
   * @private
   * @param {RTCPeerConnection} pc
   */
  _handleNewConnection(pc) {
    this.peerConnections.add(pc);

    logger.info(this.logPrefix, `New RTCPeerConnection created`);
    this.emit(EVENTS.CONNECTION_CREATED, { pc });

    // Clean up when closed or failed
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        this.peerConnections.delete(pc);
        logger.info(this.logPrefix, `PeerConnection removed (${pc.connectionState})`);
        this.emit(EVENTS.CONNECTION_CLOSED, { pc, state: pc.connectionState });
      }
    });
  }

  /**
   * Start collecting stats
   * @returns {Promise<void>}
   */
  async start() {
    // Handler already registered in initialize()
    // Add pre-existing instances from early hook registry
    const registry = getInstanceRegistry();
    if (registry.rtcPeerConnections.length > 0) {
      logger.info(this.logPrefix, `Found ${registry.rtcPeerConnections.length} pre-existing RTCPeerConnection(s) from early hook`);

      for (const { instance, timestamp } of registry.rtcPeerConnections) {
        this._handleNewConnection(instance);
      }
    }

    await this.startPolling();
  }

  /**
   * Stop collecting stats and cleanup
   * @returns {Promise<void>}
   */
  async stop() {
    await this.stopPolling();

    // Handler remains registered (initialized in initialize())
    // Do NOT restore global object to avoid breaking other extensions
    // window.RTCPeerConnection = this.originalRTCPeerConnection;
    // this.originalRTCPeerConnection = null;

    this.peerConnections.clear();
    this.previousStats.clear();
    logger.info(this.logPrefix, `Stopped and cleaned up`);
  }

  /**
   * Collect stats from all active peer connections
   * @public
   * @returns {Promise<void>}
   */
  async collectData() {
    if (this.peerConnections.size === 0) return;

    const allStats = [];
    for (const pc of this.peerConnections) {
      const stats = await this._extractPeerConnectionStats(pc);
      if (stats) allStats.push(stats);
    }

    if (allStats.length > 0) {
      this.emit(EVENTS.DATA, {
        type: DATA_TYPES.RTC_STATS,
        timestamp: Date.now(),
        peerConnections: allStats
      });
    }
  }

  /**
   * Extract stats from a single peer connection
   * @private
   * @param {RTCPeerConnection} pc - Peer connection instance
   * @returns {Promise<any>}
   */
  async _extractPeerConnectionStats(pc) {
    try {
      const report = await pc.getStats();
      const now = Date.now();

      // Single pass optimization: Map codecs and find RTP stats
      const codecs = new Map();
      let audioOutbound = null;
      let audioInbound = null;
      let remoteInbound = null;

      for (const stat of report.values()) {
        if (stat.type === 'codec') {
          codecs.set(stat.id, stat);
          continue;
        }

        // We only care about audio
        if (stat.kind !== 'audio') continue;

        switch (stat.type) {
          case 'outbound-rtp':
            audioOutbound = stat;
            break;
          case 'inbound-rtp':
            audioInbound = stat;
            break;
          case 'remote-inbound-rtp':
            remoteInbound = stat;
            break;
        }
      }

      // Get previous stats for bitrate calculation
      const prev = this.previousStats.get(pc);
      const timeDeltaSec = prev ? (now - prev.timestamp) / 1000 : 0;

      const result = {
        timestamp: now,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        send: /** @type {any} */ (null),
        recv: /** @type {any} */ (null),
        rtt: /** @type {any} */ (null)
      };

      // Outbound audio stats
      if (audioOutbound) {
        const codec = codecs.get(audioOutbound.codecId);
        const isOpus = codec?.mimeType?.toLowerCase().includes('opus');

        // Calculate send bitrate (kbps)
        let sendBitrateKbps = null;
        if (prev && timeDeltaSec > 0) {
          const bytesDelta = (audioOutbound.bytesSent || 0) - prev.bytesSent;
          sendBitrateKbps = Math.round((bytesDelta * 8) / timeDeltaSec / 1000);
        }

        result.send = {
          // Codec info
          codec: codec?.mimeType || null,
          payloadType: codec?.payloadType || null,
          clockRate: codec?.clockRate || null,
          channels: codec?.channels || null,

          // Opus parametreleri (parse edilmiş)
          opusParams: isOpus ? parseOpusParams(codec?.sdpFmtpLine) : null,

          // Bitrate & packets
          bytesSent: audioOutbound.bytesSent || 0,
          packetsSent: audioOutbound.packetsSent || 0,
          bitrateKbps: sendBitrateKbps,

          // Quality
          targetBitrate: audioOutbound.targetBitrate || null,
          retransmittedPacketsSent: audioOutbound.retransmittedPacketsSent || 0,

          // Audio level (0-1)
          audioLevel: audioOutbound.audioLevel || null
        };
      }

      // Inbound audio stats
      if (audioInbound) {
        const codec = codecs.get(audioInbound.codecId);
        const isOpus = codec?.mimeType?.toLowerCase().includes('opus');

        // Calculate receive bitrate (kbps)
        let recvBitrateKbps = null;
        if (prev && timeDeltaSec > 0) {
          const bytesDelta = (audioInbound.bytesReceived || 0) - prev.bytesReceived;
          recvBitrateKbps = Math.round((bytesDelta * 8) / timeDeltaSec / 1000);
        }

        result.recv = {
          // Codec info
          codec: codec?.mimeType || null,
          payloadType: codec?.payloadType || null,
          clockRate: codec?.clockRate || null,
          channels: codec?.channels || null,

          // Opus parametreleri (parse edilmiş)
          opusParams: isOpus ? parseOpusParams(codec?.sdpFmtpLine) : null,

          // Bitrate & packets
          bytesReceived: audioInbound.bytesReceived || 0,
          packetsReceived: audioInbound.packetsReceived || 0,
          packetsLost: audioInbound.packetsLost || 0,
          bitrateKbps: recvBitrateKbps,

          // Quality metrics (CRITICAL)
          jitter: audioInbound.jitter || 0,
          jitterBufferDelay: audioInbound.jitterBufferDelay || null,
          jitterBufferEmittedCount: audioInbound.jitterBufferEmittedCount || null,

          // Audio level
          audioLevel: audioInbound.audioLevel || null,
          totalAudioEnergy: audioInbound.totalAudioEnergy || null,
          totalSamplesReceived: audioInbound.totalSamplesReceived || null,

          // Concealment (packet loss handling)
          concealedSamples: audioInbound.concealedSamples || 0,
          silentConcealedSamples: audioInbound.silentConcealedSamples || 0,
          concealmentEvents: audioInbound.concealmentEvents || 0
        };
      }

      // RTT from remote-inbound
      if (remoteInbound) {
        result.rtt = remoteInbound.roundTripTime || null;
      }

      // Store current stats for next delta calculation
      this.previousStats.set(pc, {
        bytesSent: audioOutbound?.bytesSent || 0,
        bytesReceived: audioInbound?.bytesReceived || 0,
        timestamp: now
      });

      return result;

    } catch (err) {
      logger.error(this.logPrefix, `Stats extraction error:`, err);
      return null;
    }
  }
}

export default RTCPeerConnectionCollector;
