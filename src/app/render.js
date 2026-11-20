// Canvas rendering for source pixels and the region overlay.
//
// Two rules matter for the acceptance criteria:
//   1. Display scaling is integer nearest-neighbour only. The canvas is sized
//      width*scale x height*scale and each source pixel becomes a solid block,
//      so no filtering ever rewrites original pixel values.
//   2. The overlay is drawn from the same `labels` buffer that export reads,
//      and the legend is built from the same `summary.regions` array, so what
//      the UI shows and what is exported cannot diverge.

(function (root, factory) {
  'use strict';
  const api = factory(
    root.IWCore ? root.IWCore.compute : null
  );
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.render = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (compute) {
  'use strict';

  // Converts a parsed image into an RGBA buffer whose channel values are the
  // original intensities (8-bit verbatim; 16-bit high byte shown for display
  // only, raw samples are what the pipeline uses). Alpha is preserved for
  // RGBA inputs so transparent pixels stay visibly transparent.
  function imageToRgbaDisplay(image) {
    const width = image.width;
    const height = image.height;
    const count = width * height;
    const out = new Uint8ClampedArray(count * 4);
    if (image.rgba) {
      out.set(image.rgba.subarray(0, count * 4));
      return out;
    }
    const samples = image.samples;
    const sixteen = image.bitsPerSample === 16;
    for (let i = 0; i < count; i += 1) {
      let value;
      if (sixteen) {
        // Display-only tone map: high byte keeps ordering intact. The raw
        // Uint16 sample is untouched in `image.samples`.
        value = samples[i] >> 8;
      } else {
        value = samples[i];
      }
      const o = i * 4;
      out[o] = value;
      out[o + 1] = value;
      out[o + 2] = value;
      out[o + 3] = 255;
    }
    return out;
  }

  // Maximum canvas dimension most engines accept without silently failing.
  const MAX_CANVAS = 16384;

  // Chooses the largest integer scale <= requested that keeps the resulting
  // canvas within engine limits. Scaling is always integer and lossless.
  function clampScale(width, height, requested) {
    const limit = Math.floor(MAX_CANVAS / Math.max(width, height));
    return Math.max(1, Math.min(Math.floor(requested), Math.max(1, limit)));
  }

  // Draws a source RGBA buffer scaled by an integer factor.
  function drawScaled(ctx, source, width, height, scale) {
    const step = clampScale(width, height, scale);
    // The buffer is written at native resolution first and only then scaled by
    // the canvas with smoothing disabled, so no resampling touches values.
    const native = new ImageData(
      new Uint8ClampedArray(source),
      width,
      height
    );
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const offCtx = off.getContext('2d');
    offCtx.putImageData(native, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(off, 0, 0, width * step, height * step);
    return step;
  }

  // Scales a prebuilt RGBA overlay (from compute.buildOverlay) onto the
  // canvas. `opacity` fades the overlay over the source; the buffer itself
  // stays a pure label->colour map, so zoom redraws never rebuild it.
  function drawOverlay(ctx, overlayRgba, width, height, scale, opacity) {
    const step = clampScale(width, height, scale);
    const source = new Uint8ClampedArray(overlayRgba);
    if (opacity != null && opacity < 1) {
      const factor = Math.max(0, opacity);
      for (let i = 3; i < source.length; i += 4) {
        source[i] = Math.round(source[i] * factor);
      }
    }
    const native = new ImageData(source, width, height);
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    off.getContext('2d').putImageData(native, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, width * step, height * step);
  }

  // Converts a preview (from the worker) to an ImageData for the status panel.
  function previewToImageData(preview, colorize) {
    if (!preview) return null;
    const data = new Uint8ClampedArray(preview.width * preview.height * 4);
    for (let i = 0; i < preview.data.length; i += 1) {
      const value = preview.data[i];
      const o = i * 4;
      if (colorize === 'mask') {
        data[o] = value ? 255 : 30;
        data[o + 1] = value ? 255 : 30;
        data[o + 2] = value ? 255 : 30;
        data[o + 3] = 255;
      } else {
        data[o] = value;
        data[o + 1] = value;
        data[o + 2] = value;
        data[o + 3] = 255;
      }
    }
    return new ImageData(data, preview.width, preview.height);
  }

  return {
    MAX_CANVAS,
    clampScale,
    imageToRgbaDisplay,
    drawScaled,
    drawOverlay,
    previewToImageData,
  };
});
