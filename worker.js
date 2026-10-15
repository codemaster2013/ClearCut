/* Runs the cut-out engine off the main thread so the page never freezes.
   Every reply carries back the `id` of the request it answers, so several jobs can be in flight (the SDK relies on this). */
importScripts('engine.js');
self.onmessage = function (e) {
  var m = e.data;
  try {
    var r = self.ClearcutEngine.run(new Uint8ClampedArray(m.rgba), m.width, m.height,
      { seeds: m.seeds ? new Uint8Array(m.seeds) : null, seedsW: m.seedsW, seedsH: m.seedsH, softness: m.softness, maxOut: m.maxOut });
    self.postMessage({ id: m.id, ok: true, rgba: r.rgba.buffer, width: r.width, height: r.height, mode: r.mode }, [r.rgba.buffer]);
  } catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
};
