'use strict';

// Minimal streaming WebM (EBML) muxer — VP8/VP9, video-only, no external deps.
// Produces multi-cluster files (one cluster per ≤5 s) so relative timecodes
// never overflow int16.

// ─── EBML primitives ─────────────────────────────────────────────────────────

function u32le(v) {
  return [(v >>> 0) & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
}

function concatU8(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// Variable-length EBML integer (sizes, NOT IDs).
// Value 127 needs 2 bytes because 0xFF = unknown-size marker.
function vint(val) {
  if (val < 0x7F)
    return new Uint8Array([val | 0x80]);
  if (val < 0x3FFF)
    return new Uint8Array([(val >> 8) | 0x40, val & 0xFF]);
  if (val < 0x1FFFFF)
    return new Uint8Array([(val >> 16) | 0x20, (val >> 8) & 0xFF, val & 0xFF]);
  if (val < 0x0FFFFFFF)
    return new Uint8Array([(val >> 24) | 0x10, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF]);
  // 8-byte form for large/unknown sizes
  const hi = Math.floor(val / 0x100000000), lo = val >>> 0;
  return new Uint8Array([0x01,
    (hi >> 16) & 0xFF, (hi >> 8) & 0xFF, hi & 0xFF,
    (lo >> 24) & 0xFF, (lo >> 16) & 0xFF, (lo >> 8) & 0xFF, lo & 0xFF]);
}

// Encode a numeric value as a big-endian byte array of given length.
function numBE(val, byteLen) {
  const out = new Uint8Array(byteLen);
  for (let i = byteLen - 1; i >= 0; i--) {
    out[i] = val & 0xFF;
    val = Math.floor(val / 256);
  }
  return out;
}

// Build a master or leaf EBML element: ID (raw bytes) + vint(size) + data.
function el(id, data) { return concatU8(id, vint(data.length), data); }
function elUint(id, val, len) { return el(id, numBE(val, len)); }
function elStr(id, str) { return el(id, new TextEncoder().encode(str)); }
function elF64(id, val) {
  const b = new ArrayBuffer(8);
  new DataView(b).setFloat64(0, val, false);
  return el(id, new Uint8Array(b));
}

// ─── EBML element IDs ─────────────────────────────────────────────────────────

const ID = {
  EBML:            new Uint8Array([0x1A, 0x45, 0xDF, 0xA3]),
  EBMLVersion:     new Uint8Array([0x42, 0x86]),
  EBMLReadVersion: new Uint8Array([0x42, 0xF7]),
  EBMLMaxIDLen:    new Uint8Array([0x42, 0xF2]),
  EBMLMaxSizeLen:  new Uint8Array([0x42, 0xF3]),
  DocType:         new Uint8Array([0x42, 0x82]),
  DocTypeVersion:  new Uint8Array([0x42, 0x87]),
  DocTypeReadVer:  new Uint8Array([0x42, 0x85]),
  Segment:         new Uint8Array([0x18, 0x53, 0x80, 0x67]),
  Info:            new Uint8Array([0x15, 0x49, 0xA9, 0x66]),
  TimecodeScale:   new Uint8Array([0x2A, 0xD7, 0xB1]),
  Duration:        new Uint8Array([0x44, 0x89]),
  MuxingApp:       new Uint8Array([0x4D, 0x80]),
  WritingApp:      new Uint8Array([0x57, 0x41]),
  Tracks:          new Uint8Array([0x16, 0x54, 0xAE, 0x6B]),
  TrackEntry:      new Uint8Array([0xAE]),
  TrackNumber:     new Uint8Array([0xD7]),
  TrackUID:        new Uint8Array([0x73, 0xC5]),
  TrackType:       new Uint8Array([0x83]),
  FlagLacing:      new Uint8Array([0x9C]),
  CodecID:         new Uint8Array([0x86]),
  Video:           new Uint8Array([0xE0]),
  PixelWidth:      new Uint8Array([0xB0]),
  PixelHeight:     new Uint8Array([0xBA]),
  Cluster:         new Uint8Array([0x1F, 0x43, 0xB6, 0x75]),
  Timecode:        new Uint8Array([0xE7]),
  SimpleBlock:     new Uint8Array([0xA3]),
};

// Streaming unknown-size marker for Segment.
const UNKNOWN_SIZE = new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

// ─── Cluster builder ──────────────────────────────────────────────────────────

// Splits chunks into clusters of ≤ maxClusterMs milliseconds so the int16
// relative timecode (max 32 767 ms) never overflows.
function buildClusters(chunks, maxClusterMs = 5000) {
  const clusterParts = [];
  let clusterStart = 0;
  let clusterChunks = [];

  function flushCluster() {
    if (!clusterChunks.length) return;
    const blocks = clusterChunks.map(c => {
      const relMs = Math.round(c.timestamp_us / 1000) - clusterStart;
      // SimpleBlock: vint(track=1) + int16BE(relTimecode) + flags + VP8 data
      const hdr = new Uint8Array([0x81, (relMs >> 8) & 0xFF, relMs & 0xFF,
                                  c.isKey ? 0x80 : 0x00]);
      return el(ID.SimpleBlock, concatU8(hdr, c.data));
    });
    const timecodeEl = elUint(ID.Timecode, clusterStart, 4);
    clusterParts.push(el(ID.Cluster, concatU8(timecodeEl, ...blocks)));
    clusterChunks = [];
  }

  for (const c of chunks) {
    const ms = Math.round(c.timestamp_us / 1000);
    if (clusterChunks.length && (ms - clusterStart) >= maxClusterMs) {
      flushCluster();
      clusterStart = ms;
    }
    if (!clusterChunks.length) clusterStart = ms;
    clusterChunks.push(c);
  }
  flushCluster();
  return clusterParts;
}

// ─── Public API ───────────────────────────────────────────────────────────────

// chunks: Array of { timestamp_us: number, isKey: boolean, data: Uint8Array }
// Returns a Uint8Array containing the complete .webm file.
function muxWebM(chunks, width, height, fps, codecId = 'V_VP8') {
  const durationMs = chunks.length
    ? Math.ceil(chunks[chunks.length - 1].timestamp_us / 1000 + 1000 / fps)
    : 0;

  const ebml = el(ID.EBML, concatU8(
    elUint(ID.EBMLVersion, 1, 1),
    elUint(ID.EBMLReadVersion, 1, 1),
    elUint(ID.EBMLMaxIDLen, 4, 1),
    elUint(ID.EBMLMaxSizeLen, 8, 1),
    elStr(ID.DocType, 'webm'),
    elUint(ID.DocTypeVersion, 4, 1),
    elUint(ID.DocTypeReadVer, 2, 1),
  ));

  const info = el(ID.Info, concatU8(
    elUint(ID.TimecodeScale, 1000000, 4), // 1ms per timecode unit
    elF64(ID.Duration, durationMs),
    elStr(ID.MuxingApp, 'painterly-web'),
    elStr(ID.WritingApp, 'painterly-web'),
  ));

  const video = el(ID.Video, concatU8(
    elUint(ID.PixelWidth, width, 2),
    elUint(ID.PixelHeight, height, 2),
  ));
  const tracks = el(ID.Tracks, el(ID.TrackEntry, concatU8(
    elUint(ID.TrackNumber, 1, 1),
    elUint(ID.TrackUID, 1, 1),
    elUint(ID.TrackType, 1, 1),   // 1 = video
    elUint(ID.FlagLacing, 0, 1),
    elStr(ID.CodecID, codecId),
    video,
  )));

  const clusters = buildClusters(chunks);
  const segBody = concatU8(info, tracks, ...clusters);
  // Segment with known size (required for seeking by some players)
  const segment = concatU8(ID.Segment, vint(segBody.length), segBody);

  return concatU8(ebml, segment);
}

// ─── Exports (global) ─────────────────────────────────────────────────────────

window.muxWebM = muxWebM;
