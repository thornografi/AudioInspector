# Audio Graph Tracking

`early-inject.js` AudioNode.prototype.connect() hook'u ile audio graph topolojisi.

## Hook Implementation

```javascript
// early-inject.js
const originalConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function(destination, outputIndex, inputIndex) {
  const result = originalConnect.apply(this, arguments);

  const connection = {
    sourceType: getNodeTypeName(this),      // 'ScriptProcessor', 'Analyser'
    sourceId: getNodeId(this),              // 'node_1', 'node_2'
    destType: getNodeTypeName(destination), // 'AudioDestination'
    destId: getNodeId(destination),
    outputIndex: outputIndex ?? 0,
    inputIndex: inputIndex ?? 0,
    timestamp: Date.now()
  };

  window.__earlyCaptures.connections.push(connection);

  if (window.__audioConnectionHandler) {
    window.__audioConnectionHandler(connection);
  }

  return result;
};
```

## Node Type Detection

```javascript
const getNodeTypeName = (node) => {
  if (!node) return 'unknown';
  const name = node.constructor?.name || 'AudioNode';
  return name.replace('Node', '');  // 'ScriptProcessorNode' → 'ScriptProcessor'
};
```

## Emitted Data

```javascript
this.emit(EVENTS.DATA, {
  type: DATA_TYPES.AUDIO_CONNECTION,
  timestamp,
  connection: {
    sourceType,
    sourceId,
    destType,
    destId,
    outputIndex,
    inputIndex
  },
  allConnections: [...this.audioConnections]  // Full graph for UI
});
```

## Graph Topology Kullanımı

- Pipeline visualization
- Ses akışı analizi
- Debug için bağlantı takibi

## Storage Key

- `audio_connections` - Tüm bağlantı verileri
