'use strict';

// ─── WebGL2 backend for the Hertzmann painter ────────────────────────────────
//
// Why this exists: profiling paintHertzmann at 1920x1080 (tools/gpu-bench.html,
// and tools/profile numbers in CLAUDE.md) shows where the time actually goes —
//
//   Lab conversion 34% | Gaussian blur 25% | rasterize 21% | gradients+error 8%
//   cell pick 7%       | stroke growth 1%
//
// The part everyone assumes blocks a GPU port — stroke growth reading the live
// canvas — is 1% of runtime. Everything else is per-pixel map math over the
// whole image, which is what a GPU is for. So this backend moves the maps and
// the rasterizer to the GPU and leaves stroke *generation* on the CPU.
//
// Pipeline per layer, with the canvas living in a GPU texture the whole time:
//
//   blur(src) -> refBlur ---> lab -> labRef --\
//                        \--> sobel -> grads   >-- errMap -> readback
//   canvas ------------------> lab -> labCanvas/
//   CPU grows strokes from the readback, GPU rasterizes them into the canvas
//
// Deliberate limits:
// - GPU output is NOT bit-identical to the CPU path and never can be (float
//   rounding differs by driver). This is an opt-in mode; the CPU path stays the
//   deterministic, parity-baselined reference.
// - GPU rasterization handles the solid-stroke case only. Textured, dry-brush
//   and non-flat impasto strokes fall back to the CPU rasterizer for that
//   layer; the GPU map pipeline still applies.
// - Requires stroke batching (params.strokeBatching), because a layer's strokes
//   must be independent of each other to be drawn as one batch.

// ─── Shaders ─────────────────────────────────────────────────────────────────

// Fullscreen triangle generated from gl_VertexID — no vertex buffer needed.
const GPUH_VS_FULLSCREEN = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Separable Gaussian. The kernel is a 1-D R32F texture so any radius works
// without recompiling or hitting uniform-array limits.
const GPUH_FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uKernel;
uniform ivec2 uSize;
uniform ivec2 uDir;
uniform int uRadius;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  for (int i = -uRadius; i <= uRadius; i++) {
    ivec2 s = clamp(c + uDir * i, ivec2(0), uSize - 1);
    float k = texelFetch(uKernel, ivec2(i + uRadius, 0), 0).r;
    acc += texelFetch(uSrc, s, 0).rgb * k;
  }
  o = vec4(acc, 1.0);
}`;

// sRGB(0..255) -> CIE Lab, encoded the same way worker.js's rgbToLab does
// (L*255/100, a+128, b+128).
const GPUH_FS_LAB = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 o;
float finv(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }
void main() {
  vec3 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb / 255.0;
  vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
  float X = (lin.r * 0.4124564 + lin.g * 0.3575761 + lin.b * 0.1804375) / 0.95047;
  float Y =  lin.r * 0.2126729 + lin.g * 0.7151522 + lin.b * 0.0721750;
  float Z = (lin.r * 0.0193339 + lin.g * 0.1191920 + lin.b * 0.9503041) / 1.08883;
  float fX = finv(X), fY = finv(Y), fZ = finv(Z);
  o = vec4((116.0 * fY - 16.0) * 2.55, 500.0 * (fX - fY) + 128.0, 200.0 * (fY - fZ) + 128.0, 1.0);
}`;

// Euclidean Lab distance between reference and canvas, packed into the alpha of
// the blurred reference. Readback dominates this pipeline (~80% of the GPU map
// cost at 1080p — the shaders themselves are ~10ms), so refBlur and the error
// map share one RGBA32F target and come back in a single readPixels instead of
// two.
const GPUH_FS_ERR = `#version 300 es
precision highp float;
uniform sampler2D uRef;
uniform sampler2D uCan;
uniform sampler2D uBlur;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec3 d = texelFetch(uRef, c, 0).rgb - texelFetch(uCan, c, 0).rgb;
  o = vec4(texelFetch(uBlur, c, 0).rgb, length(d));
}`;

// Sobel on luma/255, matching worker.js computeGradients exactly (same taps,
// same normalization) so CPU and GPU stroke directions agree.
const GPUH_FS_SOBEL = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform ivec2 uSize;
out vec4 o;
float lum(ivec2 p) {
  vec3 c = texelFetch(uSrc, clamp(p, ivec2(0), uSize - 1), 0).rgb;
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255.0;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float gx = -lum(c + ivec2(-1,-1)) + lum(c + ivec2(1,-1))
             - 2.0 * lum(c + ivec2(-1,0)) + 2.0 * lum(c + ivec2(1,0))
             - lum(c + ivec2(-1,1)) + lum(c + ivec2(1,1));
  float gy = -lum(c + ivec2(-1,-1)) - 2.0 * lum(c + ivec2(0,-1)) - lum(c + ivec2(1,-1))
             + lum(c + ivec2(-1,1)) + 2.0 * lum(c + ivec2(0,1)) + lum(c + ivec2(1,1));
  o = vec4(gx, gy, sqrt(gx * gx + gy * gy), 1.0);
}`;

// Stroke rasterizer: ONE instance per stroke (not per segment). The fragment
// takes the minimum distance over every segment of the polyline, which is
// exactly what the CPU does — drawThickSegment writes max coverage into a
// single per-stroke mask, then composites that mask once. Drawing a capsule
// per segment instead (as tools/gpu-proto.js does) double-blends at the joints.
const GPUH_VS_STROKE = `#version 300 es
precision highp float;
layout(location=0) in vec2 aCorner;      // unit quad [0,1]^2
layout(location=1) in vec4 aBBox;        // minX, minY, maxX, maxY (padded)
layout(location=2) in vec2 aRange;       // point offset, point count
layout(location=3) in float aRadius;
layout(location=4) in vec3 aColor;
layout(location=5) in float aOpacity;
uniform vec2 uRes;
out vec2 vPix;
flat out vec2 vRange;
flat out float vR;
flat out vec3 vColor;
flat out float vOpacity;
void main() {
  vec2 pos = mix(aBBox.xy, aBBox.zw, aCorner);
  vPix = pos;
  vRange = aRange; vR = aRadius; vColor = aColor; vOpacity = aOpacity;
  // No Y flip. Textures here are uploaded row 0 = image row 0 and every other
  // pass addresses them with gl_FragCoord / texelFetch, which is the same
  // convention. Flipping only this pass (as tools/gpu-proto.js does, because it
  // presented to the default framebuffer) would mirror strokes vertically about
  // the image centre — the centre row would still match, which makes it a
  // genuinely sneaky bug.
  vec2 clip = (pos / uRes) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
}`;

const GPUH_FS_STROKE = `#version 300 es
precision highp float;
in vec2 vPix;
flat in vec2 vRange;
flat in float vR;
flat in vec3 vColor;
flat in float vOpacity;
uniform sampler2D uPoints;   // RG32F, one texel per polyline point
uniform int uPointsW;
out vec4 outColor;
vec2 pointAt(int i) { return texelFetch(uPoints, ivec2(i % uPointsW, i / uPointsW), 0).rg; }
void main() {
  // worker.js evaluates coverage at the integer pixel coordinate, not the pixel
  // centre; floor() here reproduces that (a +0.5 offset flips edge pixels).
  vec2 p = floor(vPix);
  int off = int(vRange.x), n = int(vRange.y);
  float best = 1e20;
  for (int i = 0; i < n - 1; i++) {
    vec2 a = pointAt(off + i), b = pointAt(off + i + 1);
    vec2 d = b - a;
    float lenSq = dot(d, d);
    float dist;
    if (lenSq < 1e-12) {
      dist = length(p - a);
    } else {
      float t = clamp(dot(p - a, d) / lenSq, 0.0, 1.0);
      dist = length(p - (a + t * d));
    }
    best = min(best, dist);
  }
  float cov = clamp(vR - best + 0.5, 0.0, 1.0);
  float a = clamp(cov * vOpacity, 0.0, 1.0);
  if (a <= 0.0) discard;
  outColor = vec4(vColor, a);
}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function gpuhCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile failed: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function gpuhProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, gpuhCompile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, gpuhCompile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

// Gaussian kernel identical to worker.js makeGaussKernel, as a 1-D R32F texture.
function gpuhKernelTexture(gl, sigma) {
  const s = Math.max(0.1, sigma);
  const radius = Math.ceil(s * 2.5);
  const size = 2 * radius + 1;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    k[i] = Math.exp(-0.5 * x * x / (s * s));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, size, 1, 0, gl.RED, gl.FLOAT, k);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { tex, radius };
}

// Is a GPU backend usable in this context at all?
function gpuHertzmannSupported() {
  try {
    if (typeof OffscreenCanvas === 'undefined') return false;
    const gl = new OffscreenCanvas(2, 2).getContext('webgl2');
    if (!gl) return false;
    const ok = !!gl.getExtension('EXT_color_buffer_float');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return ok;
  } catch (e) {
    return false;
  }
}

// ─── Backend ─────────────────────────────────────────────────────────────────

function createGpuHertzmann(w, h) {
  let gl;
  try {
    gl = new OffscreenCanvas(w, h).getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, premultipliedAlpha: false,
    });
  } catch (e) { return null; }
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;

  const N = w * h;

  const makeTex = (internal, fmt, type, width = w, height = h, data = null) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, fmt, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  const F = gl.RGBA32F, RGBA = gl.RGBA, FLOAT = gl.FLOAT;
  const texSrc     = makeTex(F, RGBA, FLOAT);
  const texCanvas  = makeTex(F, RGBA, FLOAT);
  const texTmp     = makeTex(F, RGBA, FLOAT);   // blur ping-pong
  const texRefBlur = makeTex(F, RGBA, FLOAT);
  const texLabRef  = makeTex(F, RGBA, FLOAT);
  const texLabCan  = makeTex(F, RGBA, FLOAT);
  const texErr     = makeTex(F, RGBA, FLOAT);
  const texGrad    = makeTex(F, RGBA, FLOAT);
  let   texPoints  = null;
  let   pointsW    = 0;

  const fbo = gl.createFramebuffer();
  const bindTarget = (tex) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
  };

  const progBlur  = gpuhProgram(gl, GPUH_VS_FULLSCREEN, GPUH_FS_BLUR);
  const progLab   = gpuhProgram(gl, GPUH_VS_FULLSCREEN, GPUH_FS_LAB);
  const progErr   = gpuhProgram(gl, GPUH_VS_FULLSCREEN, GPUH_FS_ERR);
  const progSobel = gpuhProgram(gl, GPUH_VS_FULLSCREEN, GPUH_FS_SOBEL);
  const progStrk  = gpuhProgram(gl, GPUH_VS_STROKE, GPUH_FS_STROKE);

  const vaoEmpty = gl.createVertexArray();

  // Instanced quad for stroke drawing.
  const vaoStroke = gl.createVertexArray();
  const quadBuf = gl.createBuffer();
  const instBuf = gl.createBuffer();
  gl.bindVertexArray(vaoStroke);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0, 1,0, 0,1, 0,1, 1,0, 1,1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // instance layout: bbox(4) range(2) radius(1) color(3) opacity(1) = 11 floats
  const STRIDE = 11 * 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  const attr = (loc, size, offset) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, offset * 4);
    gl.vertexAttribDivisor(loc, 1);
  };
  attr(1, 4, 0); attr(2, 2, 4); attr(3, 1, 6); attr(4, 3, 7); attr(5, 1, 10);
  gl.bindVertexArray(null);

  const rgba = new Float32Array(N * 4); // staging buffer for uploads/readback

  const uploadRGB = (tex, rgb) => {
    for (let i = 0; i < N; i++) {
      rgba[i*4] = rgb[i*3]; rgba[i*4+1] = rgb[i*3+1]; rgba[i*4+2] = rgb[i*3+2]; rgba[i*4+3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, RGBA, FLOAT, rgba);
  };

  const drawFullscreen = () => {
    gl.bindVertexArray(vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const bindTex = (unit, tex, prog, name) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  };

  // One separable Gaussian blur of `srcTex` into `dstTex`.
  const blurInto = (srcTex, dstTex, sigma) => {
    const { tex: kTex, radius } = gpuhKernelTexture(gl, sigma);
    gl.useProgram(progBlur);
    gl.uniform2i(gl.getUniformLocation(progBlur, 'uSize'), w, h);
    gl.uniform1i(gl.getUniformLocation(progBlur, 'uRadius'), radius);

    bindTarget(texTmp);
    bindTex(0, srcTex, progBlur, 'uSrc');
    bindTex(1, kTex, progBlur, 'uKernel');
    gl.uniform2i(gl.getUniformLocation(progBlur, 'uDir'), 1, 0);
    drawFullscreen();

    bindTarget(dstTex);
    bindTex(0, texTmp, progBlur, 'uSrc');
    bindTex(1, kTex, progBlur, 'uKernel');
    gl.uniform2i(gl.getUniformLocation(progBlur, 'uDir'), 0, 1);
    drawFullscreen();

    gl.deleteTexture(kTex);
  };

  const labInto = (srcTex, dstTex) => {
    gl.useProgram(progLab);
    bindTarget(dstTex);
    bindTex(0, srcTex, progLab, 'uSrc');
    drawFullscreen();
  };

  // Read an RGBA32F target back, de-interleaved into `out` with `ch` channels.
  const readback = (tex, out, ch) => {
    bindTarget(tex);
    gl.readPixels(0, 0, w, h, RGBA, FLOAT, rgba);
    if (ch === 1) { for (let i = 0; i < N; i++) out[i] = rgba[i*4]; }
    else if (ch === 3) {
      for (let i = 0; i < N; i++) { out[i*3] = rgba[i*4]; out[i*3+1] = rgba[i*4+1]; out[i*3+2] = rgba[i*4+2]; }
    }
    return out;
  };

  return {
    gl,
    width: w, height: h,

    setSource(srcRGB) { uploadRGB(texSrc, srcRGB); },
    setCanvas(canvasRGB) { uploadRGB(texCanvas, canvasRGB); },

    // Everything the CPU needs to generate one layer's strokes.
    // Returns { refBlur(3), gx(1), gy(1), gmag(1), err(1) }.
    layerMaps(sigma, out) {
      blurInto(texSrc, texRefBlur, sigma);
      labInto(texRefBlur, texLabRef);
      labInto(texCanvas, texLabCan);

      gl.useProgram(progErr);
      bindTarget(texErr);
      bindTex(0, texLabRef, progErr, 'uRef');
      bindTex(1, texLabCan, progErr, 'uCan');
      bindTex(2, texRefBlur, progErr, 'uBlur');
      drawFullscreen();

      gl.useProgram(progSobel);
      gl.uniform2i(gl.getUniformLocation(progSobel, 'uSize'), w, h);
      bindTarget(texGrad);
      bindTex(0, texRefBlur, progSobel, 'uSrc');
      drawFullscreen();

      // Two readbacks total: (refBlur.rgb, err) and (gx, gy, gmag).
      bindTarget(texErr);
      gl.readPixels(0, 0, w, h, RGBA, FLOAT, rgba);
      for (let i = 0; i < N; i++) {
        out.refBlur[i*3] = rgba[i*4]; out.refBlur[i*3+1] = rgba[i*4+1]; out.refBlur[i*3+2] = rgba[i*4+2];
        out.err[i] = rgba[i*4+3];
      }

      bindTarget(texGrad);
      gl.readPixels(0, 0, w, h, RGBA, FLOAT, rgba);
      for (let i = 0; i < N; i++) {
        out.gx[i] = rgba[i*4]; out.gy[i] = rgba[i*4+1]; out.gmag[i] = rgba[i*4+2];
      }
      return out;
    },

    // Underpainting is a blur of the source at the coarsest radius — the exact
    // blur layer 0 computes anyway. Doing it here saves a full CPU Gaussian
    // (~275ms at 1080p) and leaves the result already resident as the canvas.
    underpaintBlur(sigma, out) {
      blurInto(texSrc, texCanvas, sigma);
      return readback(texCanvas, out, 3);
    },

    // Draw a whole layer of solid strokes into the resident canvas texture.
    // Strokes must be in paint order — instances blend in submission order.
    rasterize(strokes) {
      if (!strokes.length) return;

      // Pack polyline points into a texture; instance rows index into it.
      let totalPts = 0;
      for (const s of strokes) totalPts += s.pts.length;
      const texW = Math.min(2048, Math.max(1, totalPts));
      const texH = Math.ceil(totalPts / texW);
      const pts = new Float32Array(texW * texH * 2);

      const inst = new Float32Array(strokes.length * 11);
      let pi = 0, ii = 0, drawn = 0;
      for (const s of strokes) {
        if (s.pts.length < 2) { pi += s.pts.length; continue; }
        const off = pi;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of s.pts) {
          pts[pi*2] = x; pts[pi*2+1] = y; pi++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const pad = s.radius + 1;
        const o = ii * 11;
        inst[o]   = Math.max(0, Math.floor(minX - pad));
        inst[o+1] = Math.max(0, Math.floor(minY - pad));
        inst[o+2] = Math.min(w, Math.ceil(maxX + pad) + 1);
        inst[o+3] = Math.min(h, Math.ceil(maxY + pad) + 1);
        inst[o+4] = off;
        inst[o+5] = s.pts.length;
        inst[o+6] = s.radius;
        // Colours stay in 0..255: the canvas texture is RGBA32F in 0..255 (the
        // Lab pass expects that range), so the blend must happen in that space.
        inst[o+7] = s.color[0]; inst[o+8] = s.color[1]; inst[o+9] = s.color[2];
        inst[o+10] = s.opacity;
        ii++; drawn++;
      }
      if (!drawn) return;

      if (texPoints) gl.deleteTexture(texPoints);
      texPoints = makeTex(gl.RG32F, gl.RG, FLOAT, texW, texH, pts);
      pointsW = texW;

      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, inst.subarray(0, drawn * 11), gl.DYNAMIC_DRAW);

      bindTarget(texCanvas);
      gl.useProgram(progStrk);
      gl.uniform2f(gl.getUniformLocation(progStrk, 'uRes'), w, h);
      gl.uniform1i(gl.getUniformLocation(progStrk, 'uPointsW'), pointsW);
      bindTex(0, texPoints, progStrk, 'uPoints');

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(vaoStroke);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, drawn);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },

    readCanvas(out) { return readback(texCanvas, out, 3); },

    destroy() {
      for (const t of [texSrc, texCanvas, texTmp, texRefBlur, texLabRef, texLabCan, texErr, texGrad, texPoints]) {
        if (t) gl.deleteTexture(t);
      }
      gl.deleteFramebuffer(fbo);
      for (const p of [progBlur, progLab, progErr, progSobel, progStrk]) gl.deleteProgram(p);
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    },
  };
}
