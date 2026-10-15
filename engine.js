/* Clearcut engine – an original background remover, written from scratch.
   No neural network, no pretrained model, no third-party code and no network access: it learns the colours of the
   background and the subject from the photo itself and refines the edge, entirely in the browser.

   How it works
   1. Work on a smaller copy of the photo in the Lab colour space (so "similar colour" matches what the eye sees).
   2. The photo's border is assumed to be background. k-means finds the typical background colours.
   3. Pixels far from those colours, near the middle, become the first guess for the subject; k-means learns its colours.
   4. Repeat 4 times: score every pixel by "closer to a subject colour or to a background colour", smooth that
      score with an edge-aware guided filter (it follows real edges instead of blurring across them), clean up
      stray blobs and small holes, and re-learn the colours from the confident areas.
   5. Optional brush strokes (keep / erase) are treated as certain, so the person can fix any mistake and run again.
   6. The soft score is upsampled to full size, snapped to the real edge with a second guided filter, turned into
      an alpha channel, and the background colour is removed from the edge pixels (de-fringing).

   Public API:  ClearcutEngine.run(rgba, width, height, options) -> { rgba, alpha, width, height }
     options.seeds    Uint8Array: 0 = unknown, 1 = keep, 2 = erase (optional); size seedsW x seedsH (default = the image size)
     options.maxWork  longest side used for the analysis step (default 640)
     options.maxOut   longest side of the result (default 2048)
     options.softness 0..1, edge softness (default 0.5)
     options.iterations (default 4)
   Works on plain typed arrays, so it also runs in a Web Worker or in Node. */
(function (root) {
  'use strict';

  /* ---------------- tunable settings (measured and tuned on a benchmark, see README) ---------------- */
  var DEFAULTS = {
    ringFrac: 0.025,                 // width of the border ring that is assumed to be backdrop
    thrK: 2.2, thrB: 4, thrMin: 9,   // first guess: a pixel is "different" if its distance > thrK*noise + thrB (at least thrMin)
    bgK: 4, fgK: 5, bgK2: 5,         // number of colour clusters: first backdrop model, subject model, backdrop model
    prior: 30,                       // softness of the subject/backdrop score
    guideEps: 0.0006, guideDiv: 55,  // edge-aware smoothing strength and radius (image size / guideDiv)
    seedPenalty: 0.15,               // how strongly border pixels are pushed towards "backdrop"
    finalEps: 0.0004, edgeBase: 0.12, edgeSoft: 0.2,
    t0K: 1.7, t0Min: 2.5, coreMin: 18, coreK: 3, coreFrac: 0.78,   // plain-backdrop matte
    floodMin: 4.5, floodK: 3.2, floodB: 2, floodAdapt: 0.195,         // adaptive backdrop: how far a pixel may differ and still count as backdrop
    floodGradK: 2.5, floodGradMin: 2.5,                              // adaptive backdrop: the flood stops at colour changes steeper than this
    fillR: 0.045, adaptP95Max: 16,                                    // adaptive backdrop: spreading radius, and the largest accepted residual
    stableK: 1.6875, stableB: 1, ridgeFrac: 0.97,                         // solid subject: colour is stable (gradient below stableK*noise+stableB) or a thin-line ridge
    bandRho: 4, bandMin: 0.8, bandTol: 0.8,                           // seams between two backdrop tones: reach in pixels, minimum colour step, tolerance
    fillThk: 3,                                                       // enclosed gaps are filled only for subjects at least this thick (never for thin line art)
    adaptiveFirst: 1, flatP95Max: 7,                                                    // the flat-backdrop method is used only when the border is this uniform
    iterations: 4
  };
  var CFG = DEFAULTS;

  /* ---------------- small helpers ---------------- */
  var LIN = new Float32Array(256);
  (function () { for (var i = 0; i < 256; i++) { var c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } })();
  function fLab(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }

  function toLab(rgba, n) {
    var L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
      var r = LIN[rgba[j]], g = LIN[rgba[j + 1]], b = LIN[rgba[j + 2]];
      var fx = fLab((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
      var fy = fLab(0.2126 * r + 0.7152 * g + 0.0722 * b);
      var fz = fLab((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
      L[i] = 116 * fy - 16; A[i] = 500 * (fx - fy); B[i] = 200 * (fy - fz);
    }
    return { L: L, A: A, B: B };
  }

  function rng(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  /* area-average downscale / bilinear upscale of an RGBA image */
  function resizeRGBA(src, w, h, nw, nh) {
    var out = new Uint8ClampedArray(nw * nh * 4), x, y, c;
    if (nw <= w && nh <= h) {                                    // box (area) filter
      for (y = 0; y < nh; y++) {
        var y0 = Math.floor(y * h / nh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / nh));
        for (x = 0; x < nw; x++) {
          var x0 = Math.floor(x * w / nw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / nw));
          var s0 = 0, s1 = 0, s2 = 0, s3 = 0, cnt = 0;
          for (var yy = y0; yy < y1; yy++) for (var xx = x0; xx < x1; xx++) { var k = (yy * w + xx) * 4; s0 += src[k]; s1 += src[k + 1]; s2 += src[k + 2]; s3 += src[k + 3]; cnt++; }
          var o = (y * nw + x) * 4; out[o] = s0 / cnt; out[o + 1] = s1 / cnt; out[o + 2] = s2 / cnt; out[o + 3] = s3 / cnt;
        }
      }
      return out;
    }
    for (y = 0; y < nh; y++) {                                   // bilinear
      var fy = (y + 0.5) * h / nh - 0.5, yA = Math.max(0, Math.floor(fy)), yB = Math.min(h - 1, yA + 1), wy = Math.min(1, Math.max(0, fy - yA));
      for (x = 0; x < nw; x++) {
        var fx = (x + 0.5) * w / nw - 0.5, xA = Math.max(0, Math.floor(fx)), xB = Math.min(w - 1, xA + 1), wx = Math.min(1, Math.max(0, fx - xA));
        for (c = 0; c < 4; c++) {
          var v = (src[(yA * w + xA) * 4 + c] * (1 - wx) + src[(yA * w + xB) * 4 + c] * wx) * (1 - wy) + (src[(yB * w + xA) * 4 + c] * (1 - wx) + src[(yB * w + xB) * 4 + c] * wx) * wy;
          out[(y * nw + x) * 4 + c] = v;
        }
      }
    }
    return out;
  }
  function resizeF32(src, w, h, nw, nh) {                       // bilinear for one float channel
    var out = new Float32Array(nw * nh);
    for (var y = 0; y < nh; y++) {
      var fy = (y + 0.5) * h / nh - 0.5, yA = Math.max(0, Math.floor(fy)), yB = Math.min(h - 1, yA + 1), wy = Math.min(1, Math.max(0, fy - yA));
      for (var x = 0; x < nw; x++) {
        var fx = (x + 0.5) * w / nw - 0.5, xA = Math.max(0, Math.floor(fx)), xB = Math.min(w - 1, xA + 1), wx = Math.min(1, Math.max(0, fx - xA));
        out[y * nw + x] = (src[yA * w + xA] * (1 - wx) + src[yA * w + xB] * wx) * (1 - wy) + (src[yB * w + xA] * (1 - wx) + src[yB * w + xB] * wx) * wy;
      }
    }
    return out;
  }
  function resizeU8Nearest(src, w, h, nw, nh) {
    var out = new Uint8Array(nw * nh);
    for (var y = 0; y < nh; y++) { var sy = Math.min(h - 1, Math.floor((y + 0.5) * h / nh)); for (var x = 0; x < nw; x++) out[y * nw + x] = src[sy * w + Math.min(w - 1, Math.floor((x + 0.5) * w / nw))]; }
    return out;
  }

  /* running-sum box blur (window clipped at the edges, so the average stays honest near borders) */
  function boxBlur(src, w, h, r) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h), x, y, i, sum, lo, hi;
    for (y = 0; y < h; y++) {
      var row = y * w; sum = 0; lo = 0; hi = Math.min(r, w - 1);
      for (i = 0; i <= hi; i++) sum += src[row + i];
      for (x = 0; x < w; x++) {
        tmp[row + x] = sum / (hi - lo + 1);
        if (x + 1 + r < w) { sum += src[row + x + 1 + r]; hi = x + 1 + r; }
        if (x - r >= 0) { sum -= src[row + x - r]; }
        lo = Math.max(0, x + 1 - r);
      }
    }
    for (x = 0; x < w; x++) {
      sum = 0; lo = 0; hi = Math.min(r, h - 1);
      for (i = 0; i <= hi; i++) sum += tmp[i * w + x];
      for (y = 0; y < h; y++) {
        out[y * w + x] = sum / (hi - lo + 1);
        if (y + 1 + r < h) { sum += tmp[(y + 1 + r) * w + x]; hi = y + 1 + r; }
        if (y - r >= 0) { sum -= tmp[(y - r) * w + x]; }
        lo = Math.max(0, y + 1 - r);
      }
    }
    return out;
  }

  /* edge-aware smoothing: the output follows the edges of the guide image I (a grey image scaled 0..1) */
  function guidedFilter(I, p, w, h, r, eps) {
    var n = w * h, i, Ip = new Float32Array(n), II = new Float32Array(n);
    for (i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    var mI = boxBlur(I, w, h, r), mp = boxBlur(p, w, h, r), mIp = boxBlur(Ip, w, h, r), mII = boxBlur(II, w, h, r);
    var a = new Float32Array(n), b = new Float32Array(n);
    for (i = 0; i < n; i++) { var v = mII[i] - mI[i] * mI[i]; a[i] = (mIp[i] - mI[i] * mp[i]) / (v + eps); b[i] = mp[i] - a[i] * mI[i]; }
    var ma = boxBlur(a, w, h, r), mb = boxBlur(b, w, h, r), q = new Float32Array(n);
    for (i = 0; i < n; i++) { var s = ma[i] * I[i] + mb[i]; q[i] = s < 0 ? 0 : (s > 1 ? 1 : s); }
    return q;
  }

  /* k-means on Lab samples (m x 3) -> { c: centres, n: members per centre } */
  function kmeans(S, m, k, iters, rand) {
    k = Math.max(1, Math.min(k, m));
    var C = new Float32Array(k * 3), i, j, c;
    var first = Math.floor(rand() * m); C[0] = S[first * 3]; C[1] = S[first * 3 + 1]; C[2] = S[first * 3 + 2];
    for (c = 1; c < k; c++) {                                    // spread the starting centres out (k-means++ style)
      var best = -1, bestD = -1;
      for (i = 0; i < Math.min(m, 400); i++) {
        var idx = Math.floor(rand() * m), dmin = 1e18;
        for (j = 0; j < c; j++) { var d0 = S[idx * 3] - C[j * 3], d1 = S[idx * 3 + 1] - C[j * 3 + 1], d2 = S[idx * 3 + 2] - C[j * 3 + 2]; var dd = d0 * d0 + d1 * d1 + d2 * d2; if (dd < dmin) dmin = dd; }
        if (dmin > bestD) { bestD = dmin; best = idx; }
      }
      C[c * 3] = S[best * 3]; C[c * 3 + 1] = S[best * 3 + 1]; C[c * 3 + 2] = S[best * 3 + 2];
    }
    var cnt = new Float32Array(k), sum = new Float32Array(k * 3);
    for (var it = 0; it < iters; it++) {
      cnt.fill(0); sum.fill(0);
      for (i = 0; i < m; i++) {
        var l = S[i * 3], a = S[i * 3 + 1], b = S[i * 3 + 2], bc = 0, bd = 1e18;
        for (c = 0; c < k; c++) { var e0 = l - C[c * 3], e1 = a - C[c * 3 + 1], e2 = b - C[c * 3 + 2]; var dd2 = e0 * e0 + e1 * e1 + e2 * e2; if (dd2 < bd) { bd = dd2; bc = c; } }
        cnt[bc]++; sum[bc * 3] += l; sum[bc * 3 + 1] += a; sum[bc * 3 + 2] += b;
      }
      for (c = 0; c < k; c++) if (cnt[c] > 0) { C[c * 3] = sum[c * 3] / cnt[c]; C[c * 3 + 1] = sum[c * 3 + 1] / cnt[c]; C[c * 3 + 2] = sum[c * 3 + 2] / cnt[c]; }
    }
    // drop clusters that hold almost nothing (stray noise)
    var keep = [], minN = Math.max(2, m * 0.01);
    for (c = 0; c < k; c++) if (cnt[c] >= minN) keep.push(c);
    if (!keep.length) keep = [0];
    var out = new Float32Array(keep.length * 3);
    for (c = 0; c < keep.length; c++) { out[c * 3] = C[keep[c] * 3]; out[c * 3 + 1] = C[keep[c] * 3 + 1]; out[c * 3 + 2] = C[keep[c] * 3 + 2]; }
    return out;
  }

  /* gather up to `max` Lab samples from pixels where mask[i] === 1 */
  function sampleMask(lab, mask, n, max, rand) {
    var total = 0, i; for (i = 0; i < n; i++) if (mask[i]) total++;
    if (!total) return { S: new Float32Array(0), m: 0 };
    var step = Math.max(1, total / max), S = new Float32Array(Math.min(total, max) * 3), m = 0, acc = 0;
    for (i = 0; i < n && m < max; i++) if (mask[i]) { acc += 1; if (acc >= step) { acc -= step; S[m * 3] = lab.L[i]; S[m * 3 + 1] = lab.A[i]; S[m * 3 + 2] = lab.B[i]; m++; } }
    return { S: S, m: m };
  }

  /* distance (squared) of every pixel to the nearest centre */
  function minDist(lab, n, C) {
    var k = C.length / 3, out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var l = lab.L[i], a = lab.A[i], b = lab.B[i], bd = 1e18;
      for (var c = 0; c < k; c++) { var d0 = l - C[c * 3], d1 = a - C[c * 3 + 1], d2 = b - C[c * 3 + 2]; var dd = d0 * d0 + d1 * d1 + d2 * d2; if (dd < bd) bd = dd; }
      out[i] = bd;
    }
    return out;
  }

  /* connected components of a 0/1 mask (4-neighbour). Returns { id, sizes } */
  function components(mask, w, h, want) {
    var n = w * h, id = new Int32Array(n), sizes = [0], stack = new Int32Array(n), next = 1;
    for (var s = 0; s < n; s++) {
      if (mask[s] !== want || id[s]) continue;
      var sp = 0, size = 0; stack[sp++] = s; id[s] = next;
      while (sp) {
        var p = stack[--sp], x = p % w, y = (p - x) / w; size++;
        if (x > 0 && mask[p - 1] === want && !id[p - 1]) { id[p - 1] = next; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] === want && !id[p + 1]) { id[p + 1] = next; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] === want && !id[p - w]) { id[p - w] = next; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] === want && !id[p + w]) { id[p + w] = next; stack[sp++] = p + w; }
      }
      sizes.push(size); next++;
    }
    return { id: id, sizes: sizes };
  }


  /* average stroke half-width of a 0/1 mask: ~R for a disc of radius R, ~t for a line t pixels wide */
  function thickness(mask, w, h) {
    var area = 0, per = 0, x, y, i;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x; if (!mask[i]) continue; area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) per++;
    }
    return per ? 2 * area / per : 0;
  }
  /* bounding box of every labelled component */
  function compBoxes(id, count, w, h) {
    var minx = new Int32Array(count).fill(1e9), maxx = new Int32Array(count).fill(-1), miny = new Int32Array(count).fill(1e9), maxy = new Int32Array(count).fill(-1);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var c = id[y * w + x]; if (!c) continue;
      if (x < minx[c]) minx[c] = x; if (x > maxx[c]) maxx[c] = x; if (y < miny[c]) miny[c] = y; if (y > maxy[c]) maxy[c] = y;
    }
    return { minx: minx, maxx: maxx, miny: miny, maxy: maxy };
  }
  /* watermark strips, caption bars and photo borders: thin pieces that run along an image edge are not the subject */
  function bannerComponents(cc, w, h) {
    var bx = compBoxes(cc.id, cc.sizes.length, w, h), bad = new Uint8Array(cc.sizes.length), c, m = 3;
    for (c = 1; c < cc.sizes.length; c++) {
      var bw = bx.maxx[c] - bx.minx[c] + 1, bh = bx.maxy[c] - bx.miny[c] + 1;
      var top = bx.miny[c] <= m, bottom = bx.maxy[c] >= h - 1 - m, left = bx.minx[c] <= m, right = bx.maxx[c] >= w - 1 - m;
      if (((top || bottom) && bw >= w * 0.5 && bh <= h * 0.14) || ((left || right) && bh >= h * 0.5 && bw <= w * 0.14)) bad[c] = 1;
    }
    return bad;
  }

  function otsu(values, n, maxV) {                               // threshold that best splits "background-like" from "different"
    var bins = 128, hist = new Float32Array(bins), i, total = 0;
    for (i = 0; i < n; i++) { var b = Math.min(bins - 1, Math.floor(values[i] / maxV * bins)); hist[b]++; total++; }
    var sumAll = 0; for (i = 0; i < bins; i++) sumAll += i * hist[i];
    var wB = 0, sumB = 0, bestVar = -1, best = bins / 4;
    for (i = 0; i < bins; i++) {
      wB += hist[i]; if (!wB) continue; var wF = total - wB; if (!wF) break;
      sumB += i * hist[i]; var mB = sumB / wB, mF = (sumAll - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > bestVar) { bestVar = v; best = i; }
    }
    return (best + 1) / bins * maxV;
  }

  function smoothstep(a, b, x) { var t = (x - a) / (b - a); t = t < 0 ? 0 : (t > 1 ? 1 : t); return t * t * (3 - 2 * t); }


  /* PLAIN BACKDROP MODE
     When one flat colour fills the border (white paper, a black screen, a green wall...) the cleanest answer is a
     colour-difference matte: how far is each pixel from the backdrop colour, and which solid foreground colour does an
     edge pixel blend towards? That keeps hair, ink strokes and other thin parts that smoothing would destroy, and gives
     true partial transparency on soft edges. */
  function plainAnalysis(lab, rgba, w, h, ringIdx, assign, rC, rk, perSide, rm, isBgCluster, p95Max) {
    var n = w * h, c, i, q, totals = new Float32Array(rk), best = -1, bestT = 0;
    for (q = 0; q < rm; q++) totals[assign[q]]++;
    for (c = 0; c < rk; c++) if (isBgCluster[c] && totals[c] > bestT) { bestT = totals[c]; best = c; }
    if (best < 0) return null;
    // a flat but noisy backdrop is split into several k-means clusters: merge the ones that sit close together
    var inGroup = new Uint8Array(rk), groupShare = 0, second = 0;
    for (c = 0; c < rk; c++) {
      var g0 = rC[c * 3] - rC[best * 3], g1 = rC[c * 3 + 1] - rC[best * 3 + 1], g2 = rC[c * 3 + 2] - rC[best * 3 + 2];
      if (Math.sqrt(g0 * g0 + g1 * g1 + g2 * g2) < 9) { inGroup[c] = 1; groupShare += totals[c]; }
    }
    for (c = 0; c < rk; c++) if (!inGroup[c] && isBgCluster[c] && totals[c] > second) second = totals[c];
    if (groupShare / rm < 0.5 || second / rm >= 0.2) return null;
    var sl = 0, sa = 0, sb = 0, sr = 0, sg = 0, sbl = 0, cnt = 0;
    for (q = 0; q < rm; q++) {
      if (!inGroup[assign[q]]) continue; i = ringIdx[q];
      sl += lab.L[i]; sa += lab.A[i]; sb += lab.B[i]; sr += rgba[i * 4]; sg += rgba[i * 4 + 1]; sbl += rgba[i * 4 + 2]; cnt++;
    }
    var Cl = sl / cnt, Ca = sa / cnt, Cb = sb / cnt, ds = [];
    for (q = 0; q < rm; q++) {
      if (!inGroup[assign[q]]) continue; i = ringIdx[q];
      var e0 = lab.L[i] - Cl, e1 = lab.A[i] - Ca, e2 = lab.B[i] - Cb; ds.push(Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2));
    }
    ds.sort(function (u, v) { return u - v; });
    var p95 = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))];
    if (p95 > p95Max) return null;
    var R = Math.max(6, p95 * 1.6), dist = new Float32Array(n), within = 0;
    for (i = 0; i < n; i++) { var f0 = lab.L[i] - Cl, f1 = lab.A[i] - Ca, f2 = lab.B[i] - Cb, d = Math.sqrt(f0 * f0 + f1 * f1 + f2 * f2); dist[i] = d; if (d < R) within++; }
    if (within / n < 0.3) return null;
    var tail = backdropTail(dist, p95, w, h); if (!tail) return null;
    return { kind: 'plain', C: [Cl, Ca, Cb], map: null, rgb: [sr / cnt, sg / cnt, sbl / cnt], p95: p95, R: R, t0: tail.t0, dCore: tail.dCore, gate: tail.gate, fill: tail.fill, thickness: tail.thk };
  }

  /* shared by the flat and the adaptive backdrop modes: given how far every pixel is from the backdrop colour,
     decide where the subject can be (gate), the "solid subject" distance (dCore) and which enclosed gaps to fill */
  function backdropTail(dist, p95, w, h) {
    var n = w * h, i, c, x, y;
    var t0 = Math.max(CFG.t0Min, CFG.t0K * p95), far = [];
    for (i = 0; i < n; i += 3) if (dist[i] > t0 * 2) far.push(dist[i]);
    // if almost nothing stands clearly apart from the backdrop (low contrast), the general method is the better tool
    if (far.length * 3 < n * 0.002) return null;
    far.sort(function (u, v) { return u - v; });
    var dCore = Math.min(Math.max(t0 * CFG.coreK, CFG.coreMin), Math.max(t0 * 2.2, CFG.coreFrac * far[Math.floor(far.length / 2)]));
    // where could the subject be?  anything clearly different from the backdrop, widened a little
    var near = new Float32Array(n);
    for (i = 0; i < n; i++) near[i] = dist[i] > t0 * 1.3 ? 1 : 0;
    var wide = boxBlur(near, w, h, 2), gm = new Uint8Array(n);
    for (i = 0; i < n; i++) gm[i] = wide[i] > 0.02 ? 1 : 0;
    var cc = components(gm, w, h, 1), bad = bannerComponents(cc, w, h), keep = new Uint8Array(cc.sizes.length);
    for (c = 1; c < cc.sizes.length; c++) keep[c] = (!bad[c] && cc.sizes[c] >= 6) ? 1 : 0;
    var gate = new Float32Array(n), strong = new Uint8Array(n);
    for (i = 0; i < n; i++) { var cid = cc.id[i]; if (cid && keep[cid]) { gate[i] = 1; strong[i] = dist[i] >= dCore ? 1 : 0; } }
    // fill enclosed gaps only for solid subjects (people, products), never for line art such as signatures
    var thk = thickness(strong, w, h), fill = new Float32Array(n);
    if (thk >= CFG.fillThk) {
      var inv = new Uint8Array(n); for (i = 0; i < n; i++) inv[i] = strong[i] ? 0 : 1;
      var hc = components(inv, w, h, 1), touches = new Uint8Array(hc.sizes.length);
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches[hc.id[y * w + x]] = 1;
      var area = 0; for (i = 0; i < n; i++) area += strong[i];
      for (i = 0; i < n; i++) { var hid = hc.id[i]; if (hid && !touches[hid] && hc.sizes[hid] < Math.max(area * 0.15, 50) && gate[i]) fill[i] = 1; }
    }
    gate = boxBlur(gate, w, h, 1);
    return { t0: t0, dCore: dCore, gate: gate, fill: fill, thk: thk };
  }

  /* ADAPTIVE BACKDROP MODE
     For gradients, vignettes, walls meeting floors and similar: flood outwards from the border while following the
     local backdrop colour (a soft change is followed, a sudden jump such as a subject edge stops the flood). What the
     flood reached is backdrop; its colour is then spread under the subject by normalised convolution, which gives the
     expected backdrop colour behind every pixel. From there it is the same colour-difference matte as the flat mode,
     so thin parts such as hair strands and ink lines survive. */
  function adaptiveBackdrop(lab, rgba, w, h, bgSeed) {
    var n = w * h, i, x, y, q;
    var sL = boxBlur(lab.L, w, h, 1), sA = boxBlur(lab.A, w, h, 1), sB = boxBlur(lab.B, w, h, 1);
    var diffs = [];
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x; if (!bgSeed[i]) continue;
      if (x + 1 < w && bgSeed[i + 1]) diffs.push(Math.hypot(sL[i] - sL[i + 1], sA[i] - sA[i + 1], sB[i] - sB[i + 1]));
      if (y + 1 < h && bgSeed[i + w]) diffs.push(Math.hypot(sL[i] - sL[i + w], sA[i] - sA[i + w], sB[i] - sB[i + w]));
    }
    if (diffs.length < 50) return null;
    diffs.sort(function (u, v) { return u - v; });
    var tau = Math.max(CFG.floodMin, CFG.floodK * diffs[Math.floor(diffs.length * 0.9)] + CFG.floodB);
    // edge stop: the flood may not cross places where colour changes much faster than it does anywhere on the backdrop
    var grad = new Float32Array(n), gs = [];
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x;
      var gx = Math.hypot(sL[i + 1] - sL[i - 1], sA[i + 1] - sA[i - 1], sB[i + 1] - sB[i - 1]) / 2, gy = Math.hypot(sL[i + w] - sL[i - w], sA[i + w] - sA[i - w], sB[i + w] - sB[i - w]) / 2;
      grad[i] = Math.hypot(gx, gy); if (bgSeed[i]) gs.push(grad[i]);
    }
    gs.sort(function (u, v) { return u - v; });
    var gStop = Math.max(CFG.floodGradMin, CFG.floodGradK * (gs.length ? gs[Math.floor(gs.length * 0.9)] : 0));
    var flag = new Uint8Array(n), RL = new Float32Array(n), RA = new Float32Array(n), RB = new Float32Array(n), queue = new Int32Array(n), qh = 0, qt = 0, a = CFG.floodAdapt;
    for (i = 0; i < n; i++) if (bgSeed[i]) { flag[i] = 1; RL[i] = sL[i]; RA[i] = sA[i]; RB[i] = sB[i]; queue[qt++] = i; }
    var nb = [0, 0, 0, 0];
    while (qh < qt) {
      var p = queue[qh++]; x = p % w; y = (p - x) / w;
      nb[0] = x > 0 ? p - 1 : -1; nb[1] = x < w - 1 ? p + 1 : -1; nb[2] = y > 0 ? p - w : -1; nb[3] = y < h - 1 ? p + w : -1;
      for (var k = 0; k < 4; k++) {
        q = nb[k]; if (q < 0 || flag[q] || grad[q] > gStop) continue;
        if (Math.hypot(sL[q] - RL[p], sA[q] - RA[p], sB[q] - RB[p]) < tau) { flag[q] = 1; RL[q] = RL[p] * (1 - a) + sL[q] * a; RA[q] = RA[p] * (1 - a) + sA[q] * a; RB[q] = RB[p] * (1 - a) + sB[q] * a; queue[qt++] = q; }
      }
    }
    // seams: a thin strip whose colour lies BETWEEN the backdrop colours on its two sides is a backdrop transition (for example
    // where a wall meets a floor), not part of the subject. A real thin line is a different colour, so it is kept.
    var band = new Uint8Array(n), nBand = 0, rho = CFG.bandRho, pass, dx, dy;
    function segHit(i, ia, ib) {
      var ax = sL[ia], ay = sA[ia], az = sB[ia], bx = sL[ib] - ax, by = sA[ib] - ay, bz = sB[ib] - az, len2 = bx * bx + by * by + bz * bz;
      if (Math.sqrt(len2) < CFG.bandMin * tau) return false;
      var px = sL[i] - ax, py = sA[i] - ay, pz = sB[i] - az, t = (px * bx + py * by + pz * bz) / len2; t = t < 0 ? 0 : (t > 1 ? 1 : t);
      return Math.hypot(px - t * bx, py - t * by, pz - t * bz) <= CFG.bandTol * tau;
    }
    for (pass = 0; pass < 2; pass++) {
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
        i = y * w + x; if (flag[i] || band[i]) continue;
        var a1 = -1, b1 = -1, a2 = -1, b2 = -1;
        for (dx = 1; dx <= rho; dx++) { if (a1 < 0 && x - dx >= 0 && (flag[i - dx] || band[i - dx])) a1 = i - dx; if (b1 < 0 && x + dx < w && (flag[i + dx] || band[i + dx])) b1 = i + dx; }
        for (dy = 1; dy <= rho; dy++) { if (a2 < 0 && y - dy >= 0 && (flag[i - dy * w] || band[i - dy * w])) a2 = i - dy * w; if (b2 < 0 && y + dy < h && (flag[i + dy * w] || band[i + dy * w])) b2 = i + dy * w; }
        if ((a1 >= 0 && b1 >= 0 && segHit(i, a1, b1)) || (a2 >= 0 && b2 >= 0 && segHit(i, a2, b2))) { band[i] = 1; nBand++; }
      }
    }
    var cov = (qt + nBand) / n; if (cov < 0.2 || cov > 0.97) return null;
    // expected backdrop colour behind every pixel: normalised convolution over the flooded pixels, two scales
    var M = new Float32Array(n), ML = new Float32Array(n), MA = new Float32Array(n), MB = new Float32Array(n), gl = 0, ga = 0, gb = 0;
    for (i = 0; i < n; i++) if (flag[i]) { M[i] = 1; ML[i] = lab.L[i]; MA[i] = lab.A[i]; MB[i] = lab.B[i]; gl += lab.L[i]; ga += lab.A[i]; gb += lab.B[i]; }
    gl /= qt; ga /= qt; gb /= qt;
    var r1 = Math.max(3, Math.round(Math.min(w, h) * CFG.fillR)), r2 = r1 * 4;
    var m1 = boxBlur(M, w, h, r1), l1 = boxBlur(ML, w, h, r1), a1 = boxBlur(MA, w, h, r1), b1 = boxBlur(MB, w, h, r1);
    var m2 = boxBlur(M, w, h, r2), l2 = boxBlur(ML, w, h, r2), a2 = boxBlur(MA, w, h, r2), b2 = boxBlur(MB, w, h, r2);
    var CL = new Float32Array(n), CA = new Float32Array(n), CB = new Float32Array(n), dist = new Float32Array(n), ds = [], sr = 0, sg = 0, sbl = 0, cnt = 0;
    for (i = 0; i < n; i++) {
      if (flag[i]) { CL[i] = sL[i]; CA[i] = sA[i]; CB[i] = sB[i]; }                    // visible backdrop: its own (lightly smoothed) colour
      else if (m1[i] > 0.04) { CL[i] = l1[i] / m1[i]; CA[i] = a1[i] / m1[i]; CB[i] = b1[i] / m1[i]; }   // hidden behind the subject: estimated from its surroundings
      else if (m2[i] > 0.002) { CL[i] = l2[i] / m2[i]; CA[i] = a2[i] / m2[i]; CB[i] = b2[i] / m2[i]; }
      else { CL[i] = gl; CA[i] = ga; CB[i] = gb; }
      if (band[i]) { CL[i] = lab.L[i]; CA[i] = lab.A[i]; CB[i] = lab.B[i]; }
      dist[i] = Math.hypot(lab.L[i] - CL[i], lab.A[i] - CA[i], lab.B[i] - CB[i]);
      if (flag[i] && (i % 3 === 0)) { ds.push(dist[i]); sr += rgba[i * 4]; sg += rgba[i * 4 + 1]; sbl += rgba[i * 4 + 2]; cnt++; }
    }
    ds.sort(function (u, v) { return u - v; });
    var p95 = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))];
    if (p95 > CFG.adaptP95Max) return null;
    var tail = backdropTail(dist, p95, w, h); if (!tail) return null;
    var bandF = new Float32Array(n); for (i = 0; i < n; i++) bandF[i] = band[i];
    return { kind: 'adaptive', C: null, band: nBand ? bandF : null, map: { L: CL, A: CA, B: CB }, rgb: [sr / cnt, sg / cnt, sbl / cnt], p95: p95, R: Math.max(6, p95 * 1.6), t0: tail.t0, dCore: tail.dCore, gate: tail.gate, fill: tail.fill, thickness: tail.thk };
  }

  /* ---------------- the analysis step (works on the small copy) ---------------- */
  function analyse(rgba, w, h, seeds, iterations) {
    var n = w * h, lab = toLab(rgba, n), rand = rng(12345), i, x, y, it;
    var gray = new Float32Array(n); for (i = 0; i < n; i++) gray[i] = lab.L[i] / 100;
    var hasFg = false, hasBg = false;
    if (seeds) for (i = 0; i < n; i++) { if (seeds[i] === 1) hasFg = true; else if (seeds[i] === 2) hasBg = true; }

    // 1) background model from the border ring (plus any "erase" strokes)
    var ring = Math.max(2, Math.round(Math.min(w, h) * CFG.ringFrac)), bgSeed = new Uint8Array(n), fgSeed = new Uint8Array(n);
    // Only trust border colours that really look like a backdrop: a colour that shows up along at least three
    // sides, or fills most of the border. A subject that runs off one edge of the photo is therefore not mistaken
    // for background.
    var ringIdx = [], ringSide = [];
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) {
        var dT = y, dBt = h - 1 - y, dL = x, dR = w - 1 - x, mn = Math.min(dT, dBt, dL, dR);
        ringIdx.push(y * w + x); ringSide.push(mn === dT ? 0 : (mn === dBt ? 1 : (mn === dL ? 2 : 3)));
      }
    }
    var rm = ringIdx.length, rS = new Float32Array(Math.min(rm, 3000) * 3), rstep = Math.max(1, rm / 3000), rcount = 0;
    for (var rr = 0; rr < rm && rcount < 3000; rr += rstep) { var ri = ringIdx[Math.floor(rr)]; rS[rcount * 3] = lab.L[ri]; rS[rcount * 3 + 1] = lab.A[ri]; rS[rcount * 3 + 2] = lab.B[ri]; rcount++; }
    var rC = kmeans(rS, rcount, 5, 8, rand), rk = rC.length / 3, assign = new Int16Array(rm), sideN = [0, 0, 0, 0], perSide = [], c0, s0;
    for (c0 = 0; c0 < rk; c0++) perSide.push([0, 0, 0, 0]);
    for (var q0 = 0; q0 < rm; q0++) {
      var pi = ringIdx[q0], bc0 = 0, bd0 = 1e18;
      for (c0 = 0; c0 < rk; c0++) { var e0 = lab.L[pi] - rC[c0 * 3], e1 = lab.A[pi] - rC[c0 * 3 + 1], e2 = lab.B[pi] - rC[c0 * 3 + 2], dd0 = e0 * e0 + e1 * e1 + e2 * e2; if (dd0 < bd0) { bd0 = dd0; bc0 = c0; } }
      assign[q0] = bc0; perSide[bc0][ringSide[q0]]++; sideN[ringSide[q0]]++;
    }
    var isBgCluster = new Uint8Array(rk), anyBg = false;
    for (c0 = 0; c0 < rk; c0++) {
      var sidesPresent = 0, total0 = 0;
      for (s0 = 0; s0 < 4; s0++) { total0 += perSide[c0][s0]; if (sideN[s0] > 0 && perSide[c0][s0] / sideN[s0] >= 0.15) sidesPresent++; }
      if (sidesPresent >= 3 || total0 / rm >= 0.35) { isBgCluster[c0] = 1; anyBg = true; }
    }
    for (var q1 = 0; q1 < rm; q1++) if (!anyBg || isBgCluster[assign[q1]]) bgSeed[ringIdx[q1]] = 1;
    for (i = 0; i < n; i++) { if (seeds && seeds[i] === 2) bgSeed[i] = 1; if (seeds && seeds[i] === 1) { fgSeed[i] = 1; bgSeed[i] = 0; } }
    if (!hasFg && !hasBg) { var flat = function (m) { return plainAnalysis(lab, rgba, w, h, ringIdx, assign, rC, rk, perSide, rm, isBgCluster, m); };
      var pl = CFG.adaptiveFirst ? (adaptiveBackdrop(lab, rgba, w, h, bgSeed) || flat(CFG.flatP95Max) || flat(14)) : (flat(CFG.flatP95Max) || adaptiveBackdrop(lab, rgba, w, h, bgSeed) || flat(14)); if (pl) return { plain: pl }; }
    var sb = sampleMask(lab, bgSeed, n, 4000, rand), bgC = kmeans(sb.S, sb.m, CFG.bgK, 8, rand);

    // 2) first guess for the subject
    var dB = minDist(lab, n, bgC), mask = new Uint8Array(n);
    {
      var inner = new Float32Array(n), cnt = 0, ix0 = Math.floor(w * 0.1), ix1 = Math.ceil(w * 0.9), iy0 = Math.floor(h * 0.1), iy1 = Math.ceil(h * 0.9);
      for (y = iy0; y < iy1; y++) for (x = ix0; x < ix1; x++) inner[cnt++] = Math.sqrt(dB[y * w + x]);
      var ringD = [], rq; for (rq = 0; rq < n; rq += 7) if (bgSeed[rq]) ringD.push(Math.sqrt(dB[rq]));
      ringD.sort(function (u, v) { return u - v; });
      var noise = ringD.length ? ringD[Math.floor(ringD.length * 0.95)] : 4, thr = Math.max(CFG.thrMin, CFG.thrK * noise + CFG.thrB);
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) { i = y * w + x; mask[i] = (!bgSeed[i] && Math.sqrt(dB[i]) > thr) ? 1 : 0; }
      var cc = components(mask, w, h, 1), bestId = 0, bestSz = 0, cx = Math.round(w / 2), cy = Math.round(h / 2);
      for (var q = 1; q < cc.sizes.length; q++) if (cc.sizes[q] > bestSz) { bestSz = cc.sizes[q]; bestId = q; }
      var centerId = cc.id[cy * w + cx];
      var keepId = (centerId && cc.sizes[centerId] > bestSz * 0.25) ? centerId : bestId;
      for (i = 0; i < n; i++) mask[i] = (keepId && cc.id[i] === keepId) ? 1 : 0;
      if (bestSz < n * 0.002) {                                  // nothing stands out: assume a central blob
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) { var ex = (x - w / 2) / (w * 0.18), ey = (y - h / 2) / (h * 0.18); mask[y * w + x] = (ex * ex + ey * ey < 1 && !bgSeed[y * w + x]) ? 1 : 0; }
      }
    }

    if (seeds) for (i = 0; i < n; i++) { if (seeds[i] === 1) mask[i] = 1; else if (seeds[i] === 2) mask[i] = 0; }   // the person's strokes always win

    var thk0 = thickness(mask, w, h), prob = new Float32Array(n), rGuide = Math.max(1, Math.min(Math.round(thk0 * 0.35), Math.round(Math.min(w, h) / CFG.guideDiv)));
    for (it = 0; it < iterations; it++) {
      // 3) learn colours from the confident interior / exterior
      var mf = new Float32Array(n), mbk = new Float32Array(n);
      for (i = 0; i < n; i++) { mf[i] = mask[i]; mbk[i] = 1 - mask[i]; }
      var er = Math.max(1, Math.min(Math.round(thk0 * 0.25), Math.round(Math.min(w, h) / 90))), fgIn = boxBlur(mf, w, h, er), bgIn = boxBlur(mbk, w, h, er);
      var fgM = new Uint8Array(n), bgM = new Uint8Array(n);
      for (i = 0; i < n; i++) { fgM[i] = (fgIn[i] > 0.97 || fgSeed[i]) ? 1 : 0; bgM[i] = (bgIn[i] > 0.97 || bgSeed[i]) ? 1 : 0; }
      var sf = sampleMask(lab, fgM, n, 4000, rand);
      if (sf.m < 20) sf = sampleMask(lab, mask, n, 4000, rand);
      var sb2 = sampleMask(lab, bgM, n, 4000, rand);
      if (!sf.m || !sb2.m) break;
      var fgC = kmeans(sf.S, sf.m, CFG.fgK, 8, rand); bgC = kmeans(sb2.S, sb2.m, CFG.bgK2, 8, rand);
      // 4) score each pixel
      var dF = minDist(lab, n, fgC); dB = minDist(lab, n, bgC);
      for (i = 0; i < n; i++) {
        var pr = (dB[i] + CFG.prior) / (dB[i] + dF[i] + 2 * CFG.prior);            // 1 = looks like the subject, 0 = looks like the background
        if (fgSeed[i]) pr = 1; else if (seeds && seeds[i] === 2) pr = 0; else if (bgSeed[i]) pr *= CFG.seedPenalty;
        prob[i] = pr;
      }
      prob = guidedFilter(gray, prob, w, h, rGuide, CFG.guideEps);
      for (i = 0; i < n; i++) { if (fgSeed[i]) prob[i] = 1; else if (seeds && seeds[i] === 2) prob[i] = 0; }
      // 5) clean up: keep the main subject (+ big pieces), fill small holes
      var raw = new Uint8Array(n); for (i = 0; i < n; i++) raw[i] = prob[i] > 0.5 ? 1 : 0;
      var fc = components(raw, w, h, 1), biggest = 0, q2;
      for (q2 = 1; q2 < fc.sizes.length; q2++) if (fc.sizes[q2] > biggest) biggest = fc.sizes[q2];
      var seedHit = new Uint8Array(fc.sizes.length); if (hasFg) for (i = 0; i < n; i++) if (fgSeed[i] && fc.id[i]) seedHit[fc.id[i]] = 1;
      for (i = 0; i < n; i++) { var cid = fc.id[i]; mask[i] = (cid && (seedHit[cid] || fc.sizes[cid] >= biggest * 0.2 || fc.sizes[cid] > n * 0.03)) ? 1 : 0; }
      var bc = components(mask, w, h, 0), borderTouch = new Uint8Array(bc.sizes.length), bgHit = new Uint8Array(bc.sizes.length);
      for (i = 0; i < n; i++) { if (bgSeed[i] && bc.id[i]) borderTouch[bc.id[i]] = 1; }
      for (i = 0; i < n; i++) { var b2 = bc.id[i]; if (b2 && !borderTouch[b2] && bc.sizes[b2] < n * 0.02) mask[i] = 1; }
    }
    var bc2 = components(mask, w, h, 1), badB = bannerComponents(bc2, w, h);
    for (i = 0; i < n; i++) { var bid = bc2.id[i]; if (bid && badB[bid]) mask[i] = 0; }
    // final soft score: the cleaned mask, snapped to image edges
    var mf2 = new Float32Array(n); for (i = 0; i < n; i++) mf2[i] = mask[i];
    var soft = guidedFilter(gray, boxBlur(mf2, w, h, 1), w, h, Math.max(2, Math.round(rGuide * 0.8)), CFG.finalEps);
    for (i = 0; i < n; i++) { if (fgSeed[i]) soft[i] = 1; else if (seeds && seeds[i] === 2) soft[i] = 0; }
    return { soft: soft };
  }

  /* ---------------- public: full pipeline ---------------- */
  function run(rgba, width, height, options) {
    options = options || {};
    CFG = options.params ? Object.assign({}, DEFAULTS, options.params) : DEFAULTS;
    var maxWork = options.maxWork || 640, maxOut = options.maxOut || 2048, iterations = options.iterations || CFG.iterations;
    var softness = options.softness == null ? 0.5 : options.softness;
    // output size
    var os = Math.min(1, maxOut / Math.max(width, height)), ow = Math.max(1, Math.round(width * os)), oh = Math.max(1, Math.round(height * os));
    var base = os < 1 ? resizeRGBA(rgba, width, height, ow, oh) : rgba;
    // analysis copy
    var ws = Math.min(1, maxWork / Math.max(ow, oh)), ww = Math.max(8, Math.round(ow * ws)), wh = Math.max(8, Math.round(oh * ws));
    var small = ws < 1 ? resizeRGBA(base, ow, oh, ww, wh) : base;
    var sw0 = options.seedsW || width, sh0 = options.seedsH || height;
    var seeds = options.seeds ? resizeU8Nearest(options.seeds, sw0, sh0, ww, wh) : null;
    var an = analyse(small, ww, wh, seeds, iterations), n = ow * oh, i, alpha = new Uint8ClampedArray(n), a = new Float32Array(n), mode = 'general', Bconst = null, plainNear = null;
    if (an.plain) {
      /* colour-difference matte computed at FULL resolution, limited to the places the analysis found */
      mode = an.plain.kind === 'adaptive' ? 'adaptive' : 'plain'; var pl = an.plain, labF = toLab(base, n), gateUp = resizeF32(pl.gate, ww, wh, ow, oh), fillUp = resizeF32(pl.fill, ww, wh, ow, oh);
      var Cl = pl.C ? pl.C[0] : 0, Ca = pl.C ? pl.C[1] : 0, Cb = pl.C ? pl.C[2] : 0, dF = new Float32Array(n), ring = Math.max(2, Math.round(Math.min(ow, oh) * 0.02)), samp = [], x, y;
      var mapL = null, mapA = null, mapB = null;
      if (pl.map) { mapL = resizeF32(pl.map.L, ww, wh, ow, oh); mapA = resizeF32(pl.map.A, ww, wh, ow, oh); mapB = resizeF32(pl.map.B, ww, wh, ow, oh); }
      for (i = 0; i < n; i++) { var e0 = labF.L[i] - (mapL ? mapL[i] : Cl), e1 = labF.A[i] - (mapA ? mapA[i] : Ca), e2 = labF.B[i] - (mapB ? mapB[i] : Cb); dF[i] = Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2); }
      if (pl.band) { var bandUp = resizeF32(pl.band, ww, wh, ow, oh); for (i = 0; i < n; i++) if (bandUp[i] > 0.5) dF[i] = 0; }
      for (y = 0; y < oh; y += 2) for (x = 0; x < ow; x += 2) if (x < ring || y < ring || x >= ow - ring || y >= oh - ring) { var dv = dF[y * ow + x]; if (dv < pl.R) samp.push(dv); }
      samp.sort(function (u, v) { return u - v; });
      var p95f = samp.length ? samp[Math.floor(samp.length * 0.95)] : pl.p95, t0 = Math.max(pl.t0, 1.7 * p95f), dCore = Math.max(pl.dCore, t0 * 2.2);
      // 1) solid foreground = clearly different from the backdrop and inside the analysed area
      var NONE = -1, nearIdx = new Int32Array(n).fill(NONE), nearD = new Float32Array(n).fill(1e9);
      // "solid subject" = clearly different from the backdrop AND either locally stable in colour or the ridge of a thin line.
      // Blurred edge pixels are therefore NOT solid; they get a partial transparency from their nearest solid neighbour.
      var grad = new Float32Array(n), gsamp = [], solid = new Uint8Array(n), gx, gy;
      for (y = 1; y < oh - 1; y++) for (x = 1; x < ow - 1; x++) {
        i = y * ow + x;
        gx = Math.hypot(labF.L[i + 1] - labF.L[i - 1], labF.A[i + 1] - labF.A[i - 1], labF.B[i + 1] - labF.B[i - 1]) / 2; gy = Math.hypot(labF.L[i + ow] - labF.L[i - ow], labF.A[i + ow] - labF.A[i - ow], labF.B[i + ow] - labF.B[i - ow]) / 2;
        grad[i] = Math.hypot(gx, gy); if (dF[i] < t0 && ((x + y) & 7) === 0) gsamp.push(grad[i]);
      }
      gsamp.sort(function (u, v) { return u - v; });
      var gStable = CFG.stableK * (gsamp.length ? gsamp[Math.floor(gsamp.length * 0.9)] : 1) + CFG.stableB;
      for (i = 0; i < n; i++) {
        if (dF[i] < dCore || gateUp[i] <= 0.5) continue;
        var ridge = false;
        if (grad[i] >= gStable) { var xx = i % ow, yy = (i - xx) / ow; if (xx > 0 && yy > 0 && xx < ow - 1 && yy < oh - 1) { var mx = Math.max(dF[i - 1], dF[i + 1], dF[i - ow], dF[i + ow], dF[i - ow - 1], dF[i - ow + 1], dF[i + ow - 1], dF[i + ow + 1]); ridge = dF[i] >= CFG.ridgeFrac * mx; } }
        if (grad[i] < gStable || ridge) { solid[i] = 1; nearIdx[i] = i; nearD[i] = 0; }
      }
      // 2) for every other pixel find the nearest solid foreground pixel (two-pass chamfer propagation)
      function relax(i, j, cost) { var v = nearD[j] + cost; if (v < nearD[i]) { nearD[i] = v; nearIdx[i] = nearIdx[j]; } }
      for (y = 0; y < oh; y++) for (x = 0; x < ow; x++) { i = y * ow + x; if (x > 0) relax(i, i - 1, 1); if (y > 0) { relax(i, i - ow, 1); if (x > 0) relax(i, i - ow - 1, 1.414); if (x < ow - 1) relax(i, i - ow + 1, 1.414); } }
      for (y = oh - 1; y >= 0; y--) for (x = ow - 1; x >= 0; x--) { i = y * ow + x; if (x < ow - 1) relax(i, i + 1, 1); if (y < oh - 1) { relax(i, i + ow, 1); if (x < ow - 1) relax(i, i + ow + 1, 1.414); if (x > 0) relax(i, i + ow - 1, 1.414); } }
      var maxR = Math.max(4, Math.max(ow, oh) * 0.004), gamma = 1.3 - 0.6 * softness;
      // 3) alpha of an edge pixel = how far along the line (backdrop colour -> nearby solid colour) it lies
      for (i = 0; i < n; i++) {
        var g = gateUp[i], v;
        if (solid[i]) v = 1;
        else if (dF[i] <= t0 || g <= 0.02 || nearIdx[i] === NONE || nearD[i] > maxR) v = 0;
        else {
          var cL = mapL ? mapL[i] : Cl, cA = mapA ? mapA[i] : Ca, cB = mapB ? mapB[i] : Cb;
          var f = nearIdx[i], u0 = labF.L[f] - cL, u1 = labF.A[f] - cA, u2 = labF.B[f] - cB, uu = u0 * u0 + u1 * u1 + u2 * u2;
          var p0 = labF.L[i] - cL, p1 = labF.A[i] - cA, p2 = labF.B[i] - cB;
          v = uu > 1 ? (p0 * u0 + p1 * u1 + p2 * u2) / uu : 0; v = v < 0 ? 0 : (v > 1 ? 1 : v); v = Math.pow(v, gamma) * (g > 1 ? 1 : g);
        }
        if (fillUp[i] > 0.5 && v < 1) v = Math.max(v, fillUp[i] > 1 ? 1 : fillUp[i]);
        a[i] = v;
      }
      Bconst = pl.rgb; plainNear = nearIdx;
    } else {
      var soft = an.soft, P = (ww === ow && wh === oh) ? soft : resizeF32(soft, ww, wh, ow, oh), gray = new Float32Array(n);
      for (i = 0; i < n; i++) { var j = i * 4; gray[i] = (0.299 * base[j] + 0.587 * base[j + 1] + 0.114 * base[j + 2]) / 255; }
      var rEdge = Math.max(2, Math.round(Math.max(ow, oh) / 400));
      P = guidedFilter(gray, P, ow, oh, rEdge, 0.0002);
      var lo = 0.5 - CFG.edgeBase - softness * CFG.edgeSoft, hi = 0.5 + CFG.edgeBase + softness * CFG.edgeSoft;
      for (i = 0; i < n; i++) a[i] = smoothstep(lo, hi, P[i]);
    }
    if (options.seeds) { var sd = resizeU8Nearest(options.seeds, sw0, sh0, ow, oh); for (i = 0; i < n; i++) { if (sd[i] === 1) a[i] = 1; else if (sd[i] === 2) a[i] = 0; } }
    for (i = 0; i < n; i++) alpha[i] = Math.round(a[i] * 255);
    // de-fringe: take the backdrop colour out of semi-transparent edge pixels. Fully transparent pixels keep their
    // ORIGINAL colour so that a later "restore" brush reveals the real photo.
    var out = new Uint8ClampedArray(n * 4), mc = null, mInv = null;
    if (!Bconst) {
      var inv = new Float32Array(n), ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      for (i = 0; i < n; i++) { var w0 = 1 - a[i]; inv[i] = w0 > 0.98 ? 1 : (w0 < 0.02 ? 0 : w0); var k4 = i * 4; ch[0][i] = base[k4] * inv[i]; ch[1][i] = base[k4 + 1] * inv[i]; ch[2][i] = base[k4 + 2] * inv[i]; }
      var rb = Math.max(3, Math.round(Math.max(ow, oh) / 200)); mInv = boxBlur(inv, ow, oh, rb); mc = [boxBlur(ch[0], ow, oh, rb), boxBlur(ch[1], ow, oh, rb), boxBlur(ch[2], ow, oh, rb)];
    }
    for (i = 0; i < n; i++) {
      var o = i * 4, al = a[i];
      if (al >= 0.98 || al < 0.02 || (mInv && mInv[i] < 0.02)) { out[o] = base[o]; out[o + 1] = base[o + 1]; out[o + 2] = base[o + 2]; }
      else if (plainNear && plainNear[i] >= 0) { var fo = plainNear[i] * 4; out[o] = base[fo]; out[o + 1] = base[fo + 1]; out[o + 2] = base[fo + 2]; }
      else {
        var Bk = Bconst || [mc[0][i] / mInv[i], mc[1][i] / mInv[i], mc[2][i] / mInv[i]], den = Math.max(al, Bconst ? 0.04 : 0.15);
        for (var c = 0; c < 3; c++) { var f = (base[o + c] - (1 - al) * Bk[c]) / den; out[o + c] = f < 0 ? 0 : (f > 255 ? 255 : f); }
      }
      out[o + 3] = alpha[i];
    }
    return { rgba: out, alpha: alpha, width: ow, height: oh, mode: mode };
  }

  var API = { run: run, DEFAULTS: DEFAULTS, _internals: { boxBlur: boxBlur, guidedFilter: guidedFilter, kmeans: kmeans, resizeRGBA: resizeRGBA } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.ClearcutEngine = API;
})(typeof self !== 'undefined' ? self : this);
