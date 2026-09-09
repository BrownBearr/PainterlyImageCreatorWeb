'use strict';

// ─── WebGL2 GPU rasterizer prototype (decision spike) ─────────────────────────
// Measures a GPU capsule rasterizer against the CPU renderStrokeSolid path on
// the *same* captured stroke list, so the comparison isolates the rasterizer.
// Dev-only; not wired into the app. See plan-add-multiple-ethereal-acorn.md.
//
// Depends on tools/parity-common.js (makeParityImage, parityHash) and a worker
// spawned from ../worker.js with params.captureStrokes to get the stroke list.

// ── Stroke capture via the real worker ────────────────────────────────────────
function captureStrokes(imageData, params) {
  return new Promise((resolve, reject) => {
    const w = new Worker('../worker.js');
    w.onmessage = (e) => {
      if (e.data.type === 'done') { w.terminate(); resolve(e.data.result); }
      else if (e.data.type === 'error') { w.terminate(); reject(new Error(e.data.message)); }
    };
    w.onerror = (err) => { w.terminate(); reject(new Error(err.message)); };
    w.postMessage({
      type: 'render',
      imageData: { data: new Uint8ClampedArray(imageData.data), width: imageData.width, height: imageData.height },
      params: { ...params, captureStrokes: true },
    });
  });
}

// ── CPU rasterizer (mirrors worker.js renderStrokeSolid solid path exactly) ────
// Kept standalone so the prototype never imports worker internals; the coverage
// and composite math are copied verbatim from worker.js:431 / 597–602.
function cpuRasterize(strokes, w, h, underCanvas) {
  const canvas = new Float32Array(underCanvas); // RGB float, 0–255
  const segCov = (px, py, x0, y0, x1, y1, r) => {
    const dx = x1 - x0, dy = y1 - y0;
    const lenSq = dx * dx + dy * dy;
    let dist;
    if (lenSq < 1e-12) {
      const ex = px - x0, ey = py - y0; dist = Math.sqrt(ex * ex + ey * ey);
    } else {
      const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lenSq));
      const cxp = x0 + t * dx, cyp = y0 + t * dy;
      const ex = px - cxp, ey = py - cyp; dist = Math.sqrt(ex * ex + ey * ey);
    }
    return Math.max(0, Math.min(1, r - dist + 0.5));
  };
  for (const s of strokes) {
    // Mirror renderStrokeSolid: non-dot strokes with < 2 points draw nothing.
    if (!s.dot && s.pts.length < 2) continue;
    const pts = s.pts, r = s.radius, [sr, sg, sb] = s.color, op = s.opacity;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of pts) {
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    const pad = Math.ceil(r) + 2;
    const bx0 = Math.max(0, Math.floor(minX - pad)), by0 = Math.max(0, Math.floor(minY - pad));
    const bx1 = Math.min(w, Math.ceil(maxX + pad + 1)), by1 = Math.min(h, Math.ceil(maxY + pad + 1));
    for (let py = by0; py < by1; py++) {
      for (let px = bx0; px < bx1; px++) {
        let cov = 0;
        for (let seg = 0; seg < pts.length - 1; seg++) {
          const c = segCov(px, py, pts[seg][0], pts[seg][1], pts[seg + 1][0], pts[seg + 1][1], r);
          if (c > cov) cov = c;
        }
        // caps
        const c0 = segCov(px, py, pts[0][0], pts[0][1], pts[0][0], pts[0][1], r);
        if (c0 > cov) cov = c0;
        const cn = segCov(px, py, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[pts.length - 1][0], pts[pts.length - 1][1], r);
        if (cn > cov) cov = cn;
        const a = Math.min(1, cov * op);
        if (a <= 0) continue;
        const ci = (py * w + px) * 3;
        canvas[ci]     = canvas[ci]     * (1 - a) + sr * a;
        canvas[ci + 1] = canvas[ci + 1] * (1 - a) + sg * a;
        canvas[ci + 2] = canvas[ci + 2] * (1 - a) + sb * a;
      }
    }
  }
  return canvas;
}

// ── GPU rasterizer (WebGL2, one instanced draw of per-segment capsule quads) ──
const VERT_SRC = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;   // unit quad corner in [-0.5, 1.5]-ish local
layout(location=1) in vec2 aP0;
layout(location=2) in vec2 aP1;
layout(location=3) in float aRadius;
layout(location=4) in vec3 aColor;
layout(location=5) in float aOpacity;
uniform vec2 uRes;
out vec2 vPix;      // this fragment's pixel coord
flat out vec2 vP0;
flat out vec2 vP1;
flat out float vR;
flat out vec3 vColor;
flat out float vOpacity;
void main() {
  vec2 d = aP1 - aP0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float pad = aRadius + 1.0;
  // aCorner.x in [0,1] runs along the segment (extended by pad each end);
  // aCorner.y in [-1,1] runs across (±(radius+pad)).
  vec2 along = aP0 - dir * pad + dir * (aCorner.x * (len + 2.0 * pad));
  vec2 pos = along + nrm * (aCorner.y * pad);
  vPix = pos;
  vP0 = aP0; vP1 = aP1; vR = aRadius; vColor = aColor; vOpacity = aOpacity;
  vec2 clip = (pos / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vPix;
flat in vec2 vP0;
flat in vec2 vP1;
flat in float vR;
flat in vec3 vColor;
flat in float vOpacity;
out vec4 outColor;
void main() {
  // worker.js evaluates coverage at the integer pixel coord (px,py), not the
  // pixel center — floor(vPix) reproduces that exactly (a +0.5 here introduces
  // a half-pixel offset that flips isolated edge pixels).
  vec2 p = floor(vPix);
  vec2 d = vP1 - vP0;
  float lenSq = dot(d, d);
  float dist;
  if (lenSq < 1e-12) {
    dist = length(p - vP0);
  } else {
    float t = clamp(dot(p - vP0, d) / lenSq, 0.0, 1.0);
    dist = length(p - (vP0 + t * d));
  }
  float cov = clamp(vR - dist + 0.5, 0.0, 1.0);
  float a = min(1.0, cov * vOpacity);
  if (a <= 0.0) discard;
  // Premultiplied not used; emit straight alpha, rely on blend func.
  outColor = vec4(vColor / 255.0, a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}

function makeGpuRasterizer(gl) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));

  // Unit quad (two triangles), corner.x in [0,1], corner.y in [-1,1].
  const quad = new Float32Array([0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1]);
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  const instBuf = gl.createBuffer();

  return {
    // strokes → flat per-segment instance array; returns painted RGB float buffer.
    rasterize(strokes, w, h, underCanvas) {
      // Build instance data: each segment (and each degenerate cap) is one capsule.
      const inst = [];
      for (const s of strokes) {
        const [r, g, b] = s.color;
        const pts = s.pts, rad = s.radius, op = s.opacity;
        const push = (x0, y0, x1, y1) => inst.push(x0, y0, x1, y1, rad, r, g, b, op);
        if (pts.length < 2) {
          if (s.dot) push(pts[0][0], pts[0][1], pts[0][0], pts[0][1]); // stipple disc
          continue; // non-dot single points draw nothing (matches CPU)
        }
        for (let i = 0; i < pts.length - 1; i++) push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      }
      const instArr = new Float32Array(inst);
      const count = instArr.length / 9;

      const fbo = gl.createFramebuffer();
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);

      // Upload underpainting as the initial framebuffer contents.
      const under8 = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        under8[i * 4] = Math.max(0, Math.min(255, Math.round(underCanvas[i * 3])));
        under8[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(underCanvas[i * 3 + 1])));
        under8[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(underCanvas[i * 3 + 2])));
        under8[i * 4 + 3] = 255;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, under8);

      gl.useProgram(prog);
      gl.uniform2f(gl.getUniformLocation(prog, 'uRes'), w, h);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      // corner attribute (per-vertex)
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(0, 0);

      // instance attributes (per-instance): p0(2) p1(2) radius(1) color(3) opacity(1) = 9 floats
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instArr, gl.DYNAMIC_DRAW);
      const stride = 9 * 4;
      const loc = [[1, 2, 0], [2, 2, 8], [3, 1, 16], [4, 3, 20], [5, 1, 32]];
      for (const [l, size, off] of loc) {
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, size, gl.FLOAT, false, stride, off);
        gl.vertexAttribDivisor(l, 1);
      }

      // Single instanced draws finish in well under the timer's resolution, so
      // average over a few repeats for a stable per-draw number.
      const REPS = 8;
      const t0 = performance.now();
      for (let k = 0; k < REPS; k++) gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.finish();
      const drawMs = (performance.now() - t0) / REPS;

      const tR0 = performance.now();
      const out8 = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out8);
      const readMs = performance.now() - tR0;

      gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
      // GL framebuffer origin is bottom-left; flip rows to match top-left image.
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4, dst = y * w * 4;
        rgba.set(out8.subarray(src, src + w * 4), dst);
      }
      return { rgba, drawMs, readMs, instanceCount: count };
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function floatRGBtoRGBA(buf, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = Math.max(0, Math.min(255, Math.round(buf[i * 3])));
    out[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(buf[i * 3 + 1])));
    out[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(buf[i * 3 + 2])));
    out[i * 4 + 3] = 255;
  }
  return out;
}

function diffStats(a, b, w, h) {
  let maxD = 0, sumD = 0, n = 0;
  const amp = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const dd = Math.abs(a[i * 4 + c] - b[i * 4 + c]);
      if (dd > d) d = dd;
      sumD += dd; n++;
    }
    if (d > maxD) maxD = d;
    const v = Math.min(255, d * 8);
    amp[i * 4] = v; amp[i * 4 + 1] = v; amp[i * 4 + 2] = v; amp[i * 4 + 3] = 255;
  }
  return { maxD, meanD: sumD / n, amp };
}

// Scale the parity test image to an arbitrary size (nearest) for size sweeps.
function scaleImage(img, W, H) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.height - 1, (y * img.height / H) | 0);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1, (x * img.width / W) | 0);
      out.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * W + x) * 4);
    }
  }
  return { data: out, width: W, height: H };
}

window.__gpuProto = {
  captureStrokes, cpuRasterize, makeGpuRasterizer,
  floatRGBtoRGBA, diffStats, scaleImage,
};
