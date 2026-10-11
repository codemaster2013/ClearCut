/* Clearcut editor.
   ONE editing session is shared by every tool (see `S`):
     orig      the original photo (never modified)           mask     the CURRENT alpha mask (edited by the brushes)
     fg        colours of the cut-out (from the engine)       auto     the mask the engine produced (for Reset)
     bg        the chosen background (or none)                hist     undo / redo history of mask changes
   Switching between Brush, Background and Export never rebuilds anything from the upload: they only change what is
   shown or how the same mask is edited. The brushes edit the mask, not the photo, so Restore can bring back the true
   original pixels at any time. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var drop = $('drop'), fileIn = $('file'), editor = $('editor'), stage = $('stage'), view = $('view'), busy = $('busy'), msg = $('msg');
  var vctx = view.getContext('2d');

  /* ------------------------------ session ------------------------------ */
  var S = {
    name: 'photo', orig: null, OW: 0, OH: 0,            // original (full size, kept for original-size export)
    W: 0, H: 0, origC: null,                              // working size (<= 2048) copy of the original
    cutC: null, cutX: null, cutData: null,                // canvas holding the cut-out (colours + current mask as alpha)
    mask: null, auto: null,                               // Uint8ClampedArray(W*H)
    bg: { type: 'none', color: '#ffffff', g: ['#8b5cf6', '#06b6d4'], img: null }, bgC: null, bgDirty: true,
    tool: 'brush', brush: { mode: 'erase', size: 44, hard: 55, ghost: false },
    hist: [], redo: [], histBytes: 0,
    z: 1, ox: 0, oy: 0, fit: 1, ready: false, method: ''
  };
  var worker = null, running = false, strokeBase = null, stroke = null, pointers = {}, hover = null, spaceDown = false, panMode = false;
  var needDraw = false, raf = 0, checkPat = null;

  function say(t, err) { msg.textContent = t || ''; msg.style.color = err ? '#ff8a8a' : ''; }

  /* ------------------------------ loading ------------------------------ */
  function decode(file) {
    var viaImg = function () {
      return new Promise(function (res, rej) {
        var u = URL.createObjectURL(file), im = new Image();
        im.onload = function () { URL.revokeObjectURL(u); res(im); }; im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('decode')); }; im.src = u;
      });
    };
    if (window.createImageBitmap) return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(file); }).catch(viaImg);
    return viaImg();
  }
  function newCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  function load(file) {
    if (!file) return;
    if (running) { say('Please wait until the current photo has finished.', true); return; }
    if (!/^image\//.test(file.type || 'image/x')) { say('That file is not an image.', true); return; }
    decode(file).then(function (im) {
      var iw = im.width || im.naturalWidth, ih = im.height || im.naturalHeight, k = Math.min(1, 2048 / Math.max(iw, ih));
      S.orig = im; S.OW = iw; S.OH = ih; S.W = Math.max(1, Math.round(iw * k)); S.H = Math.max(1, Math.round(ih * k));
      S.origC = newCanvas(S.W, S.H); var oc = S.origC.getContext('2d', { willReadFrequently: true }); oc.imageSmoothingQuality = 'high'; oc.drawImage(im, 0, 0, S.W, S.H);
      S.name = (file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
      S.hist = []; S.redo = []; S.histBytes = 0; S.ready = false; S.mask = S.auto = null; S.cutC = null;
      S.bg = { type: 'none', color: '#ffffff', g: ['#8b5cf6', '#06b6d4'], img: null }; S.bgC = null; S.bgDirty = true; syncBgUI();
      drop.classList.add('hide'); editor.classList.remove('hide'); layout(); resetView(); updateButtons();
      autoCut();
    }).catch(function () { say('This photo could not be opened. Try a JPG, PNG or WebP.', true); });
  }

  function autoCut() {
    running = true; busy.classList.add('on'); say(''); var t0 = Date.now();
    if (!worker) { try { worker = new Worker('worker.js'); } catch (e) { running = false; busy.classList.remove('on'); say('Your browser could not start the cut-out engine.', true); return; } }
    var img = S.origC.getContext('2d').getImageData(0, 0, S.W, S.H);
    worker.onmessage = function (e) {
      running = false; busy.classList.remove('on'); var m = e.data;
      if (!m.ok) { say('Something went wrong: ' + m.error, true); return; }
      S.W = m.width; S.H = m.height;
      S.cutData = new ImageData(new Uint8ClampedArray(m.rgba), S.W, S.H);
      S.mask = new Uint8ClampedArray(S.W * S.H); S.auto = new Uint8ClampedArray(S.W * S.H);
      for (var i = 0, j = 3; i < S.mask.length; i++, j += 4) S.mask[i] = S.auto[i] = S.cutData.data[j];
      S.cutC = newCanvas(S.W, S.H); S.cutX = S.cutC.getContext('2d'); S.cutX.putImageData(S.cutData, 0, 0);
      strokeBase = new Uint8ClampedArray(S.W * S.H);
      S.method = m.mode === 'plain' ? 'plain-backdrop colour matte' : 'colour-model segmentation';
      S.ready = true; resetView(); updateButtons(); requestDraw();
      say('Done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s (' + S.method + '). Use the brush to fix anything that is not right.');
    };
    worker.onerror = function () { running = false; busy.classList.remove('on'); say('The cut-out engine stopped unexpectedly.', true); };
    worker.postMessage({ rgba: img.data.buffer, width: S.W, height: S.H, seeds: null, softness: 0.5, maxOut: Math.max(S.W, S.H) }, [img.data.buffer]);
  }

  /* ------------------------------ view (zoom / pan / drawing) ------------------------------ */
  function layout() {
    var cw = stage.parentNode.clientWidth || 340, maxH = Math.min(window.innerHeight * 0.62, 640);
    var h = S.W ? Math.max(220, Math.min(maxH, cw * S.H / S.W)) : 260;
    stage.style.height = Math.round(h) + 'px';
    var dpr = Math.min(window.devicePixelRatio || 1, 2), r = stage.getBoundingClientRect();
    view.width = Math.round(r.width * dpr); view.height = Math.round(r.height * dpr); view.dpr = dpr; view.cw = r.width; view.ch = r.height;
    if (S.W) { S.fit = Math.min(view.cw / S.W, view.ch / S.H); clampView(); }
    requestDraw();
  }
  function resetView() { S.z = 1; if (S.W) { S.fit = Math.min(view.cw / S.W, view.ch / S.H); S.ox = (view.cw - S.W * S.fit) / 2; S.oy = (view.ch - S.H * S.fit) / 2; } requestDraw(); }
  function scale() { return S.fit * S.z; }
  function clampView() {
    var sc = scale(), m = 60, w = S.W * sc, h = S.H * sc;
    if (w <= view.cw) S.ox = (view.cw - w) / 2; else S.ox = Math.min(m, Math.max(view.cw - w - m, S.ox));
    if (h <= view.ch) S.oy = (view.ch - h) / 2; else S.oy = Math.min(m, Math.max(view.ch - h - m, S.oy));
  }
  function zoomAt(px, py, z2) {
    z2 = Math.max(1, Math.min(24, z2)); var sc = scale(), ix = (px - S.ox) / sc, iy = (py - S.oy) / sc;
    S.z = z2; sc = scale(); S.ox = px - ix * sc; S.oy = py - iy * sc; clampView(); requestDraw();
  }
  function toImage(cx, cy) { var r = stage.getBoundingClientRect(), sc = scale(); return { x: (cx - r.left - S.ox) / sc, y: (cy - r.top - S.oy) / sc, px: cx - r.left, py: cy - r.top }; }

  function checker() {
    if (checkPat) return checkPat;
    var c = newCanvas(24, 24), x = c.getContext('2d'); x.fillStyle = '#d9d9d9'; x.fillRect(0, 0, 24, 24); x.fillStyle = '#a8a8a8'; x.fillRect(0, 0, 12, 12); x.fillRect(12, 12, 12, 12);
    return (checkPat = vctx.createPattern(c, 'repeat'));
  }
  function requestDraw() { needDraw = true; if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0; if (!needDraw) return; needDraw = false;
    var d = view.dpr || 1; vctx.setTransform(d, 0, 0, d, 0, 0); vctx.clearRect(0, 0, view.cw, view.ch);
    if (!S.W || !S.origC) return;
    var sc = scale(), x = S.ox, y = S.oy, w = S.W * sc, h = S.H * sc;
    vctx.imageSmoothingEnabled = sc < 3; vctx.imageSmoothingQuality = 'high';
    vctx.save(); vctx.beginPath(); vctx.rect(x, y, w, h); vctx.clip();
    if (S.bg.type === 'none') { vctx.fillStyle = checker(); vctx.fillRect(x, y, w, h); }
    else { ensureBg(); vctx.drawImage(S.bgC, x, y, w, h); }
    if (S.ready) {
      if (S.tool === 'brush' && S.brush.ghost) { vctx.globalAlpha = 0.4; vctx.drawImage(S.origC, x, y, w, h); vctx.globalAlpha = 1; }
      vctx.drawImage(S.cutC, x, y, w, h);
    } else { vctx.globalAlpha = 0.55; vctx.drawImage(S.origC, x, y, w, h); vctx.globalAlpha = 1; }
    vctx.restore();
    vctx.strokeStyle = 'rgba(167,139,250,.5)'; vctx.lineWidth = 1; vctx.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);
    if (S.ready && S.tool === 'brush' && hover && !panMode && !spaceDown) {          // brush outline
      var r = S.brush.size / 2; vctx.lineWidth = 1.5; vctx.strokeStyle = S.brush.mode === 'erase' ? '#ff6b6b' : '#34d399';
      vctx.beginPath(); vctx.arc(hover.px, hover.py, r, 0, 6.2832); vctx.stroke();
      vctx.strokeStyle = 'rgba(0,0,0,.45)'; vctx.beginPath(); vctx.arc(hover.px, hover.py, r + 1.5, 0, 6.2832); vctx.stroke();
    }
  }

  /* ------------------------------ background layer ------------------------------ */
  function paintBg(ctx, w, h) {
    var b = S.bg;
    if (b.type === 'color') { ctx.fillStyle = b.color; ctx.fillRect(0, 0, w, h); }
    else if (b.type === 'gradient') {
      var g = ctx.createLinearGradient(0, 0, w * 0.8, h); g.addColorStop(0, b.g[0]); g.addColorStop(1, b.g[1]); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    } else if (b.type === 'image' && b.img) {
      var iw = b.img.width || b.img.naturalWidth, ih = b.img.height || b.img.naturalHeight, k = Math.max(w / iw, h / ih), dw = iw * k, dh = ih * k; ctx.drawImage(b.img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
  }
  function ensureBg() {
    if (S.bgC && S.bgC.width === S.W && S.bgC.height === S.H && !S.bgDirty) return;
    S.bgC = newCanvas(S.W, S.H); paintBg(S.bgC.getContext('2d'), S.W, S.H); S.bgDirty = false;
  }
  function setBg(patch) { for (var k in patch) S.bg[k] = patch[k]; S.bgDirty = true; syncBgUI(); requestDraw(); }

  /* ------------------------------ brush: edits the MASK ------------------------------ */
  function stamp(cx, cy, rad, hard, mode, box) {
    var W = S.W, H = S.H, x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(W - 1, Math.ceil(cx + rad)), y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(H - 1, Math.ceil(cy + rad));
    if (x1 < x0 || y1 < y0) return;
    var inner = rad * hard, span = Math.max(0.0001, rad - inner), mask = S.mask, data = S.cutData.data;
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy); if (d >= rad) continue;
        var cov = 1; if (d > inner) { var t = (d - inner) / span; cov = 1 - t * t * (3 - 2 * t); }
        var i = y * W + x, m = mask[i], nm = mode === 'erase' ? m * (1 - cov) : m + (255 - m) * cov;
        mask[i] = nm; data[i * 4 + 3] = mask[i];
      }
    }
    if (x0 < box.x0) box.x0 = x0; if (y0 < box.y0) box.y0 = y0; if (x1 > box.x1) box.x1 = x1; if (y1 > box.y1) box.y1 = y1;
  }
  function emptyBox() { return { x0: 1e9, y0: 1e9, x1: -1, y1: -1 }; }
  function flush(box) { if (box.x1 < box.x0) return; S.cutX.putImageData(S.cutData, 0, 0, box.x0, box.y0, box.x1 - box.x0 + 1, box.y1 - box.y0 + 1); requestDraw(); }
  function mergeBox(a, b) { if (b.x1 < b.x0) return; a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1); }

  function beginStroke(p) {
    strokeBase.set(S.mask);
    stroke = { mode: S.brush.mode, rad: Math.max(0.6, (S.brush.size / 2) / scale()), hard: S.brush.hard / 100, last: p, box: emptyBox(), total: emptyBox() };
    stamp(p.x, p.y, stroke.rad, stroke.hard, stroke.mode, stroke.box); mergeBox(stroke.total, stroke.box); flush(stroke.box); stroke.box = emptyBox();
  }
  function moveStroke(p) {
    var dx = p.x - stroke.last.x, dy = p.y - stroke.last.y, dist = Math.sqrt(dx * dx + dy * dy), step = Math.max(0.75, stroke.rad * 0.22), n = Math.max(1, Math.ceil(dist / step));
    for (var k = 1; k <= n; k++) stamp(stroke.last.x + dx * k / n, stroke.last.y + dy * k / n, stroke.rad, stroke.hard, stroke.mode, stroke.box);
    stroke.last = p; mergeBox(stroke.total, stroke.box); flush(stroke.box); stroke.box = emptyBox();
  }
  function endStroke() {
    if (!stroke) return; var b = stroke.total; stroke = null; if (b.x1 < b.x0) return;
    var w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, before = new Uint8ClampedArray(w * h), after = new Uint8ClampedArray(w * h), changed = false;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) { var i = (b.y0 + y) * S.W + b.x0 + x; before[y * w + x] = strokeBase[i]; after[y * w + x] = S.mask[i]; if (before[y * w + x] !== after[y * w + x]) changed = true; }
    if (changed) pushHist({ x: b.x0, y: b.y0, w: w, h: h, before: before, after: after });
  }

  /* ------------------------------ history ------------------------------ */
  function pushHist(e) {
    S.hist.push(e); S.histBytes += e.before.length * 2; S.redo = [];
    while (S.histBytes > 150e6 && S.hist.length > 1) { var o = S.hist.shift(); S.histBytes -= o.before.length * 2; }
    updateButtons();
  }
  function applyPatch(e, which) {
    var src = e[which], W = S.W, data = S.cutData.data;
    for (var y = 0; y < e.h; y++) for (var x = 0; x < e.w; x++) { var i = (e.y + y) * W + e.x + x, v = src[y * e.w + x]; S.mask[i] = v; data[i * 4 + 3] = v; }
    S.cutX.putImageData(S.cutData, 0, 0, e.x, e.y, e.w, e.h); requestDraw();
  }
  function undo() { if (!S.hist.length || stroke) return; var e = S.hist.pop(); applyPatch(e, 'before'); S.redo.push(e); updateButtons(); }
  function redo() { if (!S.redo.length || stroke) return; var e = S.redo.pop(); applyPatch(e, 'after'); S.hist.push(e); updateButtons(); }
  function resetEdits() {
    if (!S.ready || stroke) return; var diff = false, n = S.mask.length, i;
    for (i = 0; i < n; i++) if (S.mask[i] !== S.auto[i]) { diff = true; break; }
    if (!diff) { say('Nothing to reset: the cut-out is already the automatic result.'); return; }
    var e = { x: 0, y: 0, w: S.W, h: S.H, before: new Uint8ClampedArray(S.mask), after: new Uint8ClampedArray(S.auto) };
    pushHist(e); applyPatch(e, 'after'); say('Back to the automatic result. You can undo this.');
  }

  /* ------------------------------ pointer input ------------------------------ */
  var pinch = null;
  function pcount() { return Object.keys(pointers).length; }
  stage.addEventListener('pointerdown', function (e) {
    if (!S.W) return; try { stage.setPointerCapture(e.pointerId); } catch (x) {}
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (pcount() === 2) { endStroke(); var k = Object.keys(pointers), a = pointers[k[0]], b = pointers[k[1]]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; stage._pan = null; return; }
    if (pcount() > 2) return;
    var p = toImage(e.clientX, e.clientY); hover = p;
    var drawing = S.ready && S.tool === 'brush' && !panMode && !spaceDown && e.button === 0;
    if (drawing) { e.preventDefault(); beginStroke(p); } else { stage._pan = { x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy }; stage.classList.add('grab'); }
  });
  stage.addEventListener('pointermove', function (e) {
    var p = toImage(e.clientX, e.clientY); hover = p;
    if (!pointers[e.pointerId]) { if (S.tool === 'brush') requestDraw(); return; }
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (pinch && pcount() === 2) {
      var k = Object.keys(pointers), a = pointers[k[0]], b = pointers[k[1]], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, r = stage.getBoundingClientRect();
      S.ox += mx - pinch.mx; S.oy += my - pinch.my; zoomAt(mx - r.left, my - r.top, S.z * d / Math.max(1, pinch.d)); pinch.d = d; pinch.mx = mx; pinch.my = my; return;
    }
    if (stroke) { e.preventDefault(); moveStroke(p); return; }
    if (stage._pan) { S.ox = stage._pan.ox + (e.clientX - stage._pan.x); S.oy = stage._pan.oy + (e.clientY - stage._pan.y); clampView(); requestDraw(); return; }
    if (S.tool === 'brush') requestDraw();
  });
  function up(e) {
    delete pointers[e.pointerId]; if (pcount() < 2) pinch = null;
    if (pcount() === 0) { endStroke(); stage._pan = null; stage.classList.remove('grab'); if (e.pointerType === 'touch') { hover = null; requestDraw(); } }
  }
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') { hover = null; requestDraw(); } });
  stage.addEventListener('wheel', function (e) {
    if (!S.W) return; e.preventDefault(); var r = stage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, S.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
  }, { passive: false });
  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  window.addEventListener('resize', function () { if (S.W) layout(); });

  /* ------------------------------ UI wiring ------------------------------ */
  function updateButtons() {
    $('undo').disabled = !S.hist.length; $('redo').disabled = !S.redo.length; $('reset').disabled = !S.ready;
    [].forEach.call(document.querySelectorAll('[data-needs-ready]'), function (b) { b.disabled = !S.ready; });
    var big = S.OW > S.W || S.OH > S.H; $('origRow').classList.toggle('hide', !big);
    $('sizeNote').textContent = S.W ? ('Result size: ' + S.W + ' × ' + S.H + ' px' + (big ? ' (your original is ' + S.OW + ' × ' + S.OH + ')' : '')) : '';
  }
  function setTool(t) {
    S.tool = t;
    [].forEach.call(document.querySelectorAll('.tab'), function (b) { var on = b.getAttribute('data-tool') === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    ['brush', 'bg', 'export'].forEach(function (k) { $('p-' + k).classList.toggle('hide', k !== t); });
    stage.classList.toggle('brushing', t === 'brush'); requestDraw();
  }
  [].forEach.call(document.querySelectorAll('.tab'), function (b) { b.addEventListener('click', function () { setTool(b.getAttribute('data-tool')); }); });

  function setMode(m) { S.brush.mode = m; $('mErase').classList.toggle('on', m === 'erase'); $('mRestore').classList.toggle('on', m === 'restore'); requestDraw(); }
  $('mErase').addEventListener('click', function () { setMode('erase'); }); $('mRestore').addEventListener('click', function () { setMode('restore'); });
  $('size').addEventListener('input', function () { S.brush.size = +this.value; requestDraw(); });
  $('hard').addEventListener('input', function () { S.brush.hard = +this.value; });
  $('ghost').addEventListener('change', function () { S.brush.ghost = this.checked; requestDraw(); });
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo); $('reset').addEventListener('click', resetEdits);
  $('zin').addEventListener('click', function () { zoomAt(view.cw / 2, view.ch / 2, S.z * 1.5); });
  $('zout').addEventListener('click', function () { zoomAt(view.cw / 2, view.ch / 2, S.z / 1.5); });
  $('zfit').addEventListener('click', resetView);
  $('hand').addEventListener('click', function () { panMode = !panMode; this.classList.toggle('on', panMode); stage.classList.toggle('panmode', panMode); requestDraw(); });

  /* background tool */
  var SWATCHES = ['#ffffff', '#000000', '#f1f5f9', '#ef4444', '#f59e0b', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
  var GRADS = [['#8b5cf6', '#06b6d4'], ['#f97316', '#ec4899'], ['#0f172a', '#334155'], ['#fde68a', '#fca5a5'], ['#22c55e', '#0ea5e9'], ['#1e1b4b', '#7c3aed']];
  var sw = $('swatches'), gr = $('grads');
  var none = document.createElement('button'); none.type = 'button'; none.className = 'sw chk'; none.setAttribute('aria-label', 'Transparent'); none.setAttribute('data-k', 'none'); sw.appendChild(none);
  SWATCHES.forEach(function (c) { var b = document.createElement('button'); b.type = 'button'; b.className = 'sw'; b.style.background = c; b.setAttribute('aria-label', 'Colour ' + c); b.setAttribute('data-k', 'c:' + c); sw.appendChild(b); });
  GRADS.forEach(function (g, i) { var b = document.createElement('button'); b.type = 'button'; b.className = 'sw g'; b.style.background = 'linear-gradient(135deg,' + g[0] + ',' + g[1] + ')'; b.setAttribute('aria-label', 'Gradient ' + (i + 1)); b.setAttribute('data-k', 'g:' + i); gr.appendChild(b); });
  sw.addEventListener('click', function (e) { var k = e.target.getAttribute && e.target.getAttribute('data-k'); if (!k) return; if (k === 'none') setBg({ type: 'none' }); else setBg({ type: 'color', color: k.slice(2) }); });
  gr.addEventListener('click', function (e) { var k = e.target.getAttribute && e.target.getAttribute('data-k'); if (!k) return; setBg({ type: 'gradient', g: GRADS[+k.slice(2)] }); });
  $('custom').addEventListener('input', function () { setBg({ type: 'color', color: this.value }); });
  $('bgImgBtn').addEventListener('click', function () { $('bgImg').value = ''; $('bgImg').click(); });
  $('bgImg').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    decode(f).then(function (im) { setBg({ type: 'image', img: im }); }).catch(function () { say('That background image could not be opened.', true); });
  });
  function syncBgUI() {
    var b = S.bg, key = b.type === 'none' ? 'none' : (b.type === 'color' ? 'c:' + b.color : '');
    [].forEach.call(document.querySelectorAll('#swatches .sw, #grads .sw'), function (x) {
      var k = x.getAttribute('data-k'), on = k === key || (b.type === 'gradient' && k === 'g:' + GRADS.indexOf(b.g));
      x.classList.toggle('on', !!on);
    });
    $('bgImgBtn').classList.toggle('on', b.type === 'image');
    $('pngbgOpt').disabled = b.type === 'none'; if (b.type === 'none' && $('fmt').value === 'pngbg') $('fmt').value = 'png';
  }

  /* ------------------------------ export (same composition as the editor) ------------------------------ */
  function composeFinal(fmt, original) {
    var W = S.W, H = S.H, w = original ? S.OW : W, h = original ? S.OH : H, c = newCanvas(w, h), x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    if (fmt === 'jpg' || fmt === 'pngbg') { if (S.bg.type === 'none') { x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); } else paintBg(x, w, h); }
    if (!original) { x.drawImage(S.cutC, 0, 0); return c; }
    // original size: the ORIGINAL pixels, with the current mask (smoothly enlarged) as their transparency
    var layer = newCanvas(w, h), lx = layer.getContext('2d'); lx.imageSmoothingQuality = 'high'; lx.drawImage(S.orig, 0, 0, w, h);
    var mc = newCanvas(W, H), md = new ImageData(W, H), i;
    for (i = 0; i < S.mask.length; i++) md.data[i * 4 + 3] = S.mask[i];
    mc.getContext('2d').putImageData(md, 0, 0);
    lx.globalCompositeOperation = 'destination-in'; lx.drawImage(mc, 0, 0, w, h); lx.globalCompositeOperation = 'source-over';
    x.drawImage(layer, 0, 0); return c;
  }
  $('dl').addEventListener('click', function () {
    if (!S.ready) return;
    var fmt = $('fmt').value, original = $('orig').checked && !$('origRow').classList.contains('hide');
    say('Preparing your download…');
    setTimeout(function () {
      var c = composeFinal(fmt, original), type = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
      c.toBlob(function (blob) {
        if (!blob) { say('Could not create the file.', true); return; }
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = S.name + '-cutout' + (fmt === 'pngbg' ? '-bg' : '') + (fmt === 'jpg' ? '.jpg' : '.png');
        document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        say('Saved ' + c.width + ' × ' + c.height + ' px ' + (fmt === 'jpg' ? 'JPG' : 'PNG') + (fmt === 'png' ? ' with a transparent background.' : '.'));
      }, type, 0.95);
    }, 30);
  });

  /* ------------------------------ files, keyboard, offline ------------------------------ */
  function pick() { fileIn.value = ''; fileIn.click(); }
  drop.addEventListener('click', pick); drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  $('newPic').addEventListener('click', pick);
  fileIn.addEventListener('change', function () { load(fileIn.files && fileIn.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  document.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) load(f); });
  document.addEventListener('paste', function (e) { var it = (e.clipboardData && e.clipboardData.items) || []; for (var i = 0; i < it.length; i++) if (it[i].kind === 'file' && /^image\//.test(it[i].type)) { load(it[i].getAsFile()); return; } });
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || ''; if (/INPUT|SELECT|TEXTAREA/.test(tag) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    var mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (!mod && S.W) {
      if (k === ' ') { spaceDown = true; stage.classList.add('panmode'); e.preventDefault(); requestDraw(); }
      else if (k === 'b') setTool('brush'); else if (k === 'e') { setTool('brush'); setMode('erase'); } else if (k === 'r') { setTool('brush'); setMode('restore'); }
      else if (k === '[') { $('size').value = Math.max(8, S.brush.size - 6); S.brush.size = +$('size').value; requestDraw(); }
      else if (k === ']') { $('size').value = Math.min(160, S.brush.size + 6); S.brush.size = +$('size').value; requestDraw(); }
      else if (k === '+' || k === '=') zoomAt(view.cw / 2, view.ch / 2, S.z * 1.4); else if (k === '-') zoomAt(view.cw / 2, view.ch / 2, S.z / 1.4); else if (k === '0') resetView();
    }
  });
  document.addEventListener('keyup', function (e) { if (e.key === ' ') { spaceDown = false; if (!panMode) stage.classList.remove('panmode'); requestDraw(); } });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }
  setTool('brush'); setMode('erase'); syncBgUI(); updateButtons();
})();
