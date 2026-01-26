// @ts-check

import { logger } from '../core/Logger.js';
import PollingCollector from './PollingCollector.js';
import { EVENTS, DATA_TYPES, streamRegistry } from '../core/constants.js';
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
    // Register global handler for early hook communication
    this.registerGlobalHandler('__rtcPeerConnectionCollectorHandler', (pc) => {
      this._handleNewConnection(pc);
    });
  }

  /**
   * Handle new peer connection instance
   * @private
   * @param {RTCPeerConnection} pc
   */
  _handleNewConnection(pc) {
    // Duplicate guard: prevent adding listener twice for the same connection
    if (this.peerConnections.has(pc)) {
      logger.info(this.logPrefix, 'RTCPeerConnection already tracked, skipping duplicate');
      return;
    }
    this.peerConnections.add(pc);

    logger.info(this.logPrefix, `New RTCPeerConnection created`);
    this.emit(EVENTS.CONNECTION_CREATED, { pc });

    // Named handler references for cleanup (prevents memory leak)
    const trackHandler = (event) => {
      if (event.track.kind === 'audio') {
        for (const stream of event.streams) {
          streamRegistry.remote.add(stream.id);
          logger.info(this.logPrefix, `Remote audio stream registered: ${stream.id}`);
        }

        // Track ended olduğunda registry'den temizle (memory leak önleme)
        event.track.addEventListener('ended', () => {
          for (const stream of event.streams) {
            streamRegistry.remote.delete(stream.id);
            logger.info(this.logPrefix, `Remote audio track ended, stream ${stream.id} removed from registry`);
          }
        });
      }
    };

    const stateHandler = () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        // Cleanup: Remove event listeners to prevent memory leak
        pc.removeEventListener('track', trackHandler);
        pc.removeEventListener('connectionstatechange', stateHandler);
        this.peerConnections.delete(pc);
        logger.info(this.logPrefix, `PeerConnection removed (${pc.connectionState})`);
        this.emit(EVENTS.CONNECTION_CLOSED, { pc, state: pc.connectionState });
      }
    };

    // Track remote audio streams for source detection
    // AudioContextCollector will query streamRegistry to distinguish microphone vs remote
    pc.addEventListener('track', trackHandler);

    // Clean up when closed or failed
    pc.addEventListener('connectionstatechange', stateHandler);
  }

  /**
   * Hook: Process early captures from registry
   * Handler already registered in initialize()
   * @protected
   * @override
   * @returns {Promise<number>} Number of processed connections
   */
  async _processEarlyInstances() {
    let processedCount = 0;

    const registry = getInstanceRegistry();
    if (registry.rtcPeerConnections.length > 0) {
      logger.info(this.logPrefix, `Found ${registry.rtcPeerConnections.length} pre-existing RTCPeerConnection(s) from early hook`);

      for (const { instance, timestamp } of registry.rtcPeerConnections) {
        this._handleNewConnection(instance);
        processedCount++;
      }
    }

    return processedCount;
  }

  /**
   * Hook: Post-start actions - start polling
   * @protected
   * @override
   * @param {number} processedCount
   * @returns {Promise<void>}
   */
  async _onStartComplete(processedCount) {
    await this.startPolling();
  }

  /**
   * Re-emit current data from active peer connections
   * Called when UI needs to be refreshed (e.g., after data reset)
   *
   * NOTE: Overrides BaseCollector.reEmit() entirely because this collector
   * uses collectData() for real-time stats aggregation across all connections.
   * @override
   */
  reEmit() {
    if (!this.active) return;

    // Use existing collectData method which emits current stats
    this.collectData().then(() => {
      if (this.peerConnections.size > 0) {
        logger.info(this.logPrefix, `Re-emitted ${this.peerConnections.size} PeerConnection(s)`);
      }
    });
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

    // Clear remote stream registry to prevent memory leak
    // Individual track 'ended' listeners also clean up, but this ensures full cleanup on stop
    streamRegistry.remote.clear();

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
   * Calculate bitrate in kbps from bytes delta and time delta
   * @private
   * @param {number} bytesDelta - Bytes transferred since last measurement
   * @param {number} timeDeltaSec - Time elapsed in seconds
   * @returns {number|null} Bitrate in kbps or null if calculation not possible
   */
  _calculateBitrateKbps(bytesDelta, timeDeltaSec) {
    if (timeDeltaSec <= 0) return null;
    return Math.round((bytesDelta * 8) / timeDeltaSec / 1000);
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
        const sendBytesDelta = prev ? (audioOutbound.bytesSent || 0) - prev.bytesSent : 0;
        const sendBitrateKbps = prev ? this._calculateBitrateKbps(sendBytesDelta, timeDeltaSec) : null;

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
        const recvBytesDelta = prev ? (audioInbound.bytesReceived || 0) - prev.bytesReceived : 0;
        const recvBitrateKbps = prev ? this._calculateBitrateKbps(recvBytesDelta, timeDeltaSec) : null;

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
      // Preserve previous values if current stats unavailable (prevents bitrate spikes)
      this.previousStats.set(pc, {
        bytesSent: audioOutbound?.bytesSent ?? prev?.bytesSent ?? 0,
        bytesReceived: audioInbound?.bytesReceived ?? prev?.bytesReceived ?? 0,
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
