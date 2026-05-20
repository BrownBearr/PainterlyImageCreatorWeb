'use strict';

// Minimal streaming WebM (EBML) muxer — VP8/VP9, video-only, no external deps.
// Produces a standards-compliant file with SeekHead, DefaultDuration, and
// proper track flags so FFmpeg / Blender can open it.

// ─── EBML primitives ─────────────────────────────────────────────────────────

function concatU8(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// Variable-length EBML integer (sizes, NOT IDs).
// 0x7F is special (127 needs 2 bytes because 0xFF = unknown-size marker).
function vint(val) {
  if (val < 0x7F)
    return new Uint8Array([val | 0x80]);
  if (val < 0x3FFF)
    return new Uint8Array([(val >> 8) | 0x40, val & 0xFF]);
  if (val < 0x1FFFFF)
    return new Uint8Array([(val >> 16) | 0x20, (val >> 8) & 0xFF, val & 0xFF]);
  if (val < 0x0FFFFFFF)
    return new Uint8Array([(val >> 24) | 0x10, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF]);
  const hi = Math.floor(val / 0x100000000), lo = val >>> 0;
  return new Uint8Array([0x01,
    (hi >> 16) & 0xFF, (hi >> 8) & 0xFF, hi & 0xFF,
    (lo >> 24) & 0xFF, (lo >> 16) & 0xFF, (lo >> 8) & 0xFF, lo & 0xFF]);
}

// Encode a number as big-endian bytes of exactly `byteLen` bytes.
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
  // Segment
  Segment:         new Uint8Array([0x18, 0x53, 0x80, 0x67]),
  // SeekHead
  SeekHead:        new Uint8Array([0x11, 0x4D, 0x9B, 0x74]),
  Seek:            new Uint8Array([0x4D, 0xBB]),
  SeekID:          new Uint8Array([0x53, 0xAB]),
  SeekPosition:    new Uint8Array([0x53, 0xAC]),
  // Info
  Info:            new Uint8Array([0x15, 0x49, 0xA9, 0x66]),
  TimecodeScale:   new Uint8Array([0x2A, 0xD7, 0xB1]),
  Duration:        new Uint8Array([0x44, 0x89]),
  MuxingApp:       new Uint8Array([0x4D, 0x80]),
  WritingApp:      new Uint8Array([0x57, 0x41]),
  // Tracks
  Tracks:          new Uint8Array([0x16, 0x54, 0xAE, 0x6B]),
  TrackEntry:      new Uint8Array([0xAE]),
  TrackNumber:     new Uint8Array([0xD7]),
  TrackUID:        new Uint8Array([0x73, 0xC5]),
  TrackType:       new Uint8Array([0x83]),
  FlagEnabled:     new Uint8Array([0xB9]),
  FlagDefault:     new Uint8Array([0x88]),
  FlagLacing:      new Uint8Array([0x9C]),
  DefaultDuration: new Uint8Array([0x23, 0xE3, 0x83]),
  CodecID:         new Uint8Array([0x86]),
  Video:           new Uint8Array([0xE0]),
  PixelWidth:      new Uint8Array([0xB0]),
  PixelHeight:     new Uint8Array([0xBA]),
  // Clusters
  Cluster:         new Uint8Array([0x1F, 0x43, 0xB6, 0x75]),
  Timecode:        new Uint8Array([0xE7]),
  SimpleBlock:     new Uint8Array([0xA3]),
};

// ─── Cluster builder ──────────────────────────────────────────────────────────

// Splits chunks into clusters of ≤ maxClusterMs milliseconds so int16
// relative timecodes (max 32 767 ms) never overflow.
function buildClusters(chunks, maxClusterMs = 5000) {
  const clusterParts = [];
  let clusterStart = 0;
  let clusterChunks = [];

  function flushCluster() {
    if (!clusterChunks.length) return;
    const blocks = clusterChunks.map(c => {
      const relMs = Math.round(c.timestamp_us / 1000) - clusterStart;
      // SimpleBlock header: vint(track=1) + int16BE(relTimecode) + flags
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

// ─── SeekHead builder ─────────────────────────────────────────────────────────

// Each SeekPosition is encoded as a fixed 8-byte uint so the SeekHead size is
// stable regardless of the actual offset values, enabling a two-pass approach.
function buildSeekHead(entries /* [{idBytes, offset}] */) {
  const seeks = entries.map(({ idBytes, offset }) =>
    el(ID.Seek, concatU8(
      el(ID.SeekID, new Uint8Array(idBytes)),
      el(ID.SeekPosition, numBE(offset, 8)),
    ))
  );
  return el(ID.SeekHead, concatU8(...seeks));
}

// ─── Public API ───────────────────────────────────────────────────────────────

// chunks: Array of { timestamp_us: number, isKey: boolean, data: Uint8Array }
// Returns a Uint8Array containing the complete .webm file.
function muxWebM(chunks, width, height, fps, codecId = 'V_VP8') {
  const durationMs = chunks.length
    ? Math.ceil(chunks[chunks.length - 1].timestamp_us / 1000 + 1000 / fps)
    : 0;

  // ── EBML header ──
  // DocTypeVersion 2 is correct for both VP8 and VP9 basic profiles.
  const ebml = el(ID.EBML, concatU8(
    elUint(ID.EBMLVersion, 1, 1),
    elUint(ID.EBMLReadVersion, 1, 1),
    elUint(ID.EBMLMaxIDLen, 4, 1),
    elUint(ID.EBMLMaxSizeLen, 8, 1),
    elStr(ID.DocType, 'webm'),
    elUint(ID.DocTypeVersion, 2, 1),
    elUint(ID.DocTypeReadVer, 2, 1),
  ));

  // ── Segment Info ──
  const info = el(ID.Info, concatU8(
    elUint(ID.TimecodeScale, 1_000_000, 4), // 1 timecode unit = 1 ms
    elF64(ID.Duration, durationMs),
    elStr(ID.MuxingApp, 'painterly-web'),
    elStr(ID.WritingApp, 'painterly-web'),
  ));

  // ── Tracks ──
  // DefaultDuration is in nanoseconds (absolute, not scaled by TimecodeScale).
  const defaultDurationNs = Math.round(1_000_000_000 / fps);
  const video = el(ID.Video, concatU8(
    elUint(ID.PixelWidth, width, 2),
    elUint(ID.PixelHeight, height, 2),
  ));
  const tracks = el(ID.Tracks, el(ID.TrackEntry, concatU8(
    elUint(ID.TrackNumber, 1, 1),
    elUint(ID.TrackUID, 1, 8),        // 8-byte UID required by spec
    elUint(ID.TrackType, 1, 1),       // 1 = video
    elUint(ID.FlagEnabled, 1, 1),
    elUint(ID.FlagDefault, 1, 1),
    elUint(ID.FlagLacing, 0, 1),
    elUint(ID.DefaultDuration, defaultDurationNs, 4),
    elStr(ID.CodecID, codecId),
    video,
  )));

  // ── Clusters ──
  const clusterData = concatU8(...buildClusters(chunks));

  // ── SeekHead (two-pass: measure size with dummy offsets, then use real ones) ──
  // Because SeekPosition is always 8 bytes the SeekHead size is constant.
  const seekEntryDefs = [
    { idBytes: [0x15, 0x49, 0xA9, 0x66], offset: 0 }, // Info
    { idBytes: [0x16, 0x54, 0xAE, 0x6B], offset: 0 }, // Tracks
    { idBytes: [0x1F, 0x43, 0xB6, 0x75], offset: 0 }, // first Cluster
  ];
  const seekHeadSize = buildSeekHead(seekEntryDefs).length;

  // Offsets are from the start of the Segment body (right after Segment ID+size).
  const infoOffset    = seekHeadSize;
  const tracksOffset  = seekHeadSize + info.length;
  const clusterOffset = seekHeadSize + info.length + tracks.length;

  const seekHead = buildSeekHead([
    { idBytes: [0x15, 0x49, 0xA9, 0x66], offset: infoOffset },
    { idBytes: [0x16, 0x54, 0xAE, 0x6B], offset: tracksOffset },
    { idBytes: [0x1F, 0x43, 0xB6, 0x75], offset: clusterOffset },
  ]);

  // ── Assemble ──
  const segBody = concatU8(seekHead, info, tracks, clusterData);
  // Known-size Segment (required for random access in many decoders).
  const segment = concatU8(ID.Segment, vint(segBody.length), segBody);

  return concatU8(ebml, segment);
}

// ─── Exports (global) ─────────────────────────────────────────────────────────

window.muxWebM = muxWebM;
