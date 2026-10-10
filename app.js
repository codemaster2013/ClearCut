/* Clearcut page – photo in, transparent PNG out, all on the device. The cut-out itself is done by
   engine.js (our own engine) inside a Web Worker so the screen never freezes. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var drop = $('drop'), fileIn = $('file'), work = $('work'), view = $('view'), ov = $('ov'), busy = $('busy'), msg = $('msg'), hint = $('hint');
  var editBar = $('editBar'), resBar = $('resBar'), goBtn = $('go'), goLabel = $('goLabel'), undoBtn = $('undo');
  var vctx = view.getContext('2d'), octx = ov.getContext('2d');

  var W = 0, H = 0, name = 'photo';
  var srcC = document.createElement('canvas'), seedC = document.createElement('canvas'), resC = document.createElement('canvas');
  var sctx = srcC.getContext('2d', { willReadFrequently: true }), kctx = seedC.getContext('2d', { willReadFrequently: true }), rctx = resC.getContext('2d');
  var strokes = [], cur = null, mode = 'keep', mode2 = 'edit', backdrop = 'chk', hasResult = false, worker = null, running = false;
  var COL = { keep: 'rgb(34,221,119)', erase: 'rgb(255,77,77)' };

  function say(t, err) { msg.textContent = t || ''; msg.style.color = err ? '#ff8a8a' : ''; }

  /* ---------- loading a photo ---------- */
  function decode(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return createImageBitmap(file); }).catch(function () { return viaImg(file); });
    }
    return viaImg(file);
  }
  function viaImg(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('decode')); };
      im.src = u;
    });
  }
  function load(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || 'image/x')) { say('That file is not an image.', true); return; }
    decode(file).then(function (im) {
      var iw = im.width || im.naturalWidth, ih = im.height || im.naturalHeight, s = Math.min(1, 2048 / Math.max(iw, ih));
      W = Math.max(1, Math.round(iw * s)); H = Math.max(1, Math.round(ih * s));
      srcC.width = seedC.width = resC.width = view.width = ov.width = W; srcC.height = seedC.height = resC.height = view.height = ov.height = H;
      sctx.imageSmoothingQuality = 'high'; sctx.clearRect(0, 0, W, H); sctx.drawImage(im, 0, 0, W, H);
      if (im.close) im.close();
      name = (file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
      strokes = []; cur = null; hasResult = false; undoBtn.disabled = true;
      kctx.clearRect(0, 0, W, H);
      drop.classList.add('hide'); work.classList.remove('hide');
      setView('edit'); say('');
    }).catch(function () { say('This photo could not be opened. Try a JPG, PNG or WebP.', true); });
  }

  /* ---------- drawing ---------- */
  function setView(v) {
    mode2 = v;
    if (v === 'edit') {
      ov.classList.remove('hide'); editBar.classList.remove('hide'); resBar.classList.add('hide');
      goLabel.textContent = hasResult ? 'Refine cut-out' : 'Remove background';
      paintEdit();
    } else {
      ov.classList.add('hide'); editBar.classList.add('hide'); resBar.classList.remove('hide');
      paintResult();
    }
  }
  function paintEdit() {
    view.width = W; view.height = H; vctx.drawImage(srcC, 0, 0);
    octx.clearRect(0, 0, W, H); octx.globalAlpha = 0.65; octx.drawImage(seedC, 0, 0); octx.globalAlpha = 1;
  }
  function checker() {
    var sq = Math.max(12, Math.round(W / 36)), c = document.createElement('canvas'); c.width = c.height = sq * 2;
    var x = c.getContext('2d'); x.fillStyle = '#d9d9d9'; x.fillRect(0, 0, sq * 2, sq * 2); x.fillStyle = '#9b9b9b'; x.fillRect(0, 0, sq, sq); x.fillRect(sq, sq, sq, sq);
    return vctx.createPattern(c, 'repeat');
  }
  function paintResult() {
    view.width = resC.width; view.height = resC.height;
    vctx.fillStyle = backdrop === 'chk' ? checker() : backdrop; vctx.fillRect(0, 0, view.width, view.height);
    vctx.drawImage(resC, 0, 0);
  }

  /* ---------- brush ---------- */
  function pos(e) { var r = ov.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height, k: W / r.width }; }
  function dab(st, a, b) {
    kctx.strokeStyle = kctx.fillStyle = COL[st.mode]; kctx.lineCap = kctx.lineJoin = 'round'; kctx.lineWidth = st.size;
    if (!b) { kctx.beginPath(); kctx.arc(a.x, a.y, st.size / 2, 0, 6.2832); kctx.fill(); }
    else { kctx.beginPath(); kctx.moveTo(a.x, a.y); kctx.lineTo(b.x, b.y); kctx.stroke(); }
  }
  ov.addEventListener('pointerdown', function (e) {
    if (mode2 !== 'edit' || running) return;
    e.preventDefault(); try { ov.setPointerCapture(e.pointerId); } catch (x) {}
    var p = pos(e); cur = { mode: mode, size: Math.max(3, +$('size').value * p.k), pts: [p] };
    dab(cur, p, null); paintEdit();
  });
  ov.addEventListener('pointermove', function (e) {
    if (!cur) return; e.preventDefault();
    var p = pos(e), last = cur.pts[cur.pts.length - 1]; cur.pts.push(p); dab(cur, last, p); paintEdit();
  });
  function endStroke() { if (!cur) return; strokes.push(cur); cur = null; undoBtn.disabled = false; }
  ov.addEventListener('pointerup', endStroke); ov.addEventListener('pointercancel', endStroke);
  function redrawSeeds() {
    kctx.clearRect(0, 0, W, H);
    strokes.forEach(function (st) { if (st.pts.length === 1) dab(st, st.pts[0], null); for (var i = 1; i < st.pts.length; i++) dab(st, st.pts[i - 1], st.pts[i]); });
    paintEdit();
  }
  undoBtn.addEventListener('click', function () { strokes.pop(); undoBtn.disabled = !strokes.length; redrawSeeds(); });
  $('mKeep').addEventListener('click', function () { mode = 'keep'; $('mKeep').classList.add('on'); $('mErase').classList.remove('on'); });
  $('mErase').addEventListener('click', function () { mode = 'erase'; $('mErase').classList.add('on'); $('mKeep').classList.remove('on'); });

  /* ---------- running the engine ---------- */
  function seedsArray() {
    if (!strokes.length) return null;
    var d = kctx.getImageData(0, 0, W, H).data, out = new Uint8Array(W * H), any = false;
    for (var i = 0, j = 0; i < out.length; i++, j += 4) { if (d[j + 3] > 100) { out[i] = d[j + 1] > d[j] ? 1 : 2; any = true; } }
    return any ? out : null;
  }
  function run() {
    if (running) return;
    running = true; busy.classList.add('on'); goBtn.disabled = true; say('');
    if (!worker) {
      try { worker = new Worker('worker.js'); }
      catch (e) { running = false; busy.classList.remove('on'); goBtn.disabled = false; say('Your browser could not start the cut-out engine.', true); return; }
    }
    var img = sctx.getImageData(0, 0, W, H), seeds = seedsArray(), soft = +$('soft').value / 100;
    worker.onmessage = function (e) {
      running = false; busy.classList.remove('on'); goBtn.disabled = false;
      var m = e.data;
      if (!m.ok) { say('Something went wrong: ' + m.error, true); return; }
      resC.width = m.width; resC.height = m.height;
      rctx.putImageData(new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height), 0, 0);
      hasResult = true; setView('result');
      say('Done. Not right? Tap "Fix with brush", paint a few marks and refine.');
    };
    worker.onerror = function () { running = false; busy.classList.remove('on'); goBtn.disabled = false; say('The cut-out engine stopped unexpectedly.', true); };
    var msgOut = { rgba: img.data.buffer, width: W, height: H, seeds: seeds ? seeds.buffer : null, seedsW: W, seedsH: H, softness: soft, maxOut: 2048 };
    worker.postMessage(msgOut, seeds ? [img.data.buffer, seeds.buffer] : [img.data.buffer]);
  }
  goBtn.addEventListener('click', run);
  $('fix').addEventListener('click', function () { setView('edit'); say(''); });
  var softTimer = 0;
  $('soft').addEventListener('change', function () { clearTimeout(softTimer); softTimer = setTimeout(run, 150); });

  /* ---------- preview backdrop + download ---------- */
  [].forEach.call(document.querySelectorAll('.sw'), function (b) {
    b.addEventListener('click', function () {
      [].forEach.call(document.querySelectorAll('.sw'), function (x) { x.classList.remove('on'); });
      b.classList.add('on'); backdrop = b.getAttribute('data-bg'); if (mode2 === 'result') paintResult();
    });
  });
  $('dl').addEventListener('click', function () {
    resC.toBlob(function (blob) {
      if (!blob) { say('Could not create the PNG.', true); return; }
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name + '-cutout.png';
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }, 'image/png');
  });

  /* ---------- picking files ---------- */
  function pick() { fileIn.value = ''; fileIn.click(); }
  drop.addEventListener('click', pick);
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  $('newPic').addEventListener('click', pick); $('newPic2').addEventListener('click', pick);
  fileIn.addEventListener('change', function () { load(fileIn.files && fileIn.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  document.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) load(f); });
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { load(items[i].getAsFile()); return; }
  });
})();

/* offline support: the whole site is stored on the device after the first visit */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
}
