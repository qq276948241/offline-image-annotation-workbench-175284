// Deterministic image analysis pipeline:
//   grayscale -> local contrast -> threshold segmentation -> 4-connected labels
//
// All arithmetic is integer where the source is integer, so identical input
// always yields identical labels, areas and bounding boxes. The pipeline is a
// cooperative async routine: it yields between row chunks so a Worker can
// observe a cancellation message, and every stage reports a version-tagged
// intermediate result back to the main thread.

(function (root, factory) {
  'use strict';
  let errors;
  if (typeof module === 'object' && module.exports) {
    errors = require('./errors.js');
  } else {
    errors = root.IWCore.errors;
  }
  const api = factory(errors);
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.compute = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (errors) {
  'use strict';

  const ImageFormatError = errors.ImageFormatError;

  const STAGES = Object.freeze(['grayscale', 'contrast', 'threshold', 'labeling']);
  const CHUNK_ROWS = 32;

  const DEFAULT_PARAMS = Object.freeze({ threshold: 0.15 });

  function normalizeParams(params) {
    const raw = params || {};
    const threshold =
      raw.threshold === undefined ? DEFAULT_PARAMS.threshold : Number(raw.threshold);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new ImageFormatError('INVALID_INPUT', '阈值必须是 0..1 之间的数。', {
        threshold: raw.threshold,
      });
    }
    return { threshold };
  }

  // Cooperative yield: lets a Worker drain its message queue between chunks.
  // MessageChannel is used inside workers because it yields without the 4ms
  // setTimeout clamp; anywhere else (Node, main thread) setTimeout is fine.
  function yieldToEventLoop() {
    const inWorker = typeof importScripts === 'function';
    if (inWorker && typeof MessageChannel === 'function') {
      return new Promise(function (resolve) {
        const channel = new MessageChannel();
        channel.port1.onmessage = function () {
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(0);
      });
    }
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function checkpoint(shouldCancel, stage) {
    return yieldToEventLoop().then(function () {
      if (shouldCancel && shouldCancel()) {
        throw new ImageFormatError(
          'PIPELINE_CANCELLED',
          '计算在 ' + stage + ' 阶段被取消。',
          { stage }
        );
      }
    });
  }

  function alphaAt(image, index) {
    if (!image.alpha) return 255;
    return image.alpha[index];
  }

  // --- Stage 1: grayscale -------------------------------------------------
  // PGM samples are preserved verbatim: an 8-bit sample stays 0..255 and a
  // 16-bit big-endian sample stays 0..65535 (no rescale, no clamping).
  // RGBA is converted with integer Rec.601 weights.
  function computeGrayscale(image) {
    const count = image.pixelCount;
    const gray = new Uint32Array(count);
    if (image.samples) {
      const samples = image.samples;
      for (let i = 0; i < count; i += 1) gray[i] = samples[i];
    } else if (image.rgba) {
      const rgba = image.rgba;
      for (let i = 0, o = 0; i < count; i += 1, o += 4) {
        gray[i] = Math.round(
          0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2]
        );
      }
    } else {
      throw new ImageFormatError('INVALID_INPUT', '图像缺少像素数据。');
    }
    return gray;
  }

  // --- Stage 2: local contrast -------------------------------------------
  // Local contrast is the 3x3 window range (max - min) in raw intensity units.
  // Borders clamp to the nearest valid sample, keeping the result deterministic.
  function computeLocalContrast(gray, width, height) {
    const contrast = new Uint32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const y0 = y > 0 ? y - 1 : 0;
      const y2 = y + 1 < height ? y + 1 : height - 1;
      for (let x = 0; x < width; x += 1) {
        const x0 = x > 0 ? x - 1 : 0;
        const x2 = x + 1 < width ? x + 1 : width - 1;
        let min = Infinity;
        let max = -Infinity;
        for (let yy = y0; yy <= y2; yy += 1) {
          const row = yy * width;
          for (let xx = x0; xx <= x2; xx += 1) {
            const value = gray[row + xx];
            if (value < min) min = value;
            if (value > max) max = value;
          }
        }
        contrast[y * width + x] = max - min;
      }
    }
    return contrast;
  }

  // --- Stage 3: threshold segmentation -----------------------------------
  // Threshold is normalized against the image's own max intensity, so the same
  // UI value means the same relative cut for 8-bit and 16-bit data. Pixels with
  // alpha == 0 are background by definition and never enter a region.
  function computeMask(contrast, image, params) {
    const count = image.pixelCount;
    const maxValue = image.maxValue || 255;
    const cut = params.threshold * maxValue;
    const mask = new Uint8Array(count);
    let foreground = 0;
    for (let i = 0; i < count; i += 1) {
      const active = contrast[i] > cut && alphaAt(image, i) > 0;
      mask[i] = active ? 1 : 0;
      if (active) foreground += 1;
    }
    return { mask: mask, foreground: foreground, cut: cut };
  }

  // --- Stage 4: 4-connected labeling -------------------------------------
  // Two-pass union-find over raster order; labels are renumbered by first
  // appearance, so output is stable for identical input.
  function labelRegions(mask, width, height) {
    const count = width * height;
    const parent = new Int32Array(count + 1);
    const labels = new Int32Array(count);

    for (let i = 0; i < count; i += 1) {
      parent[i] = mask[i] ? i : -1;
    }

    function find(node) {
      let current = node;
      while (parent[current] !== current) current = parent[current];
      const root = current;
      current = node;
      while (parent[current] !== root) {
        const next = parent[current];
        parent[current] = root;
        current = next;
      }
      return root;
    }

    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = row + x;
        if (!mask[index]) continue;
        if (x > 0 && mask[index - 1]) union(index, index - 1);
        if (y > 0 && mask[index - width]) union(index, index - width);
        // 4-connectivity only: diagonals never join.
      }
    }

    const rootToLabel = new Map();
    let nextLabel = 0;
    const regions = [];
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const index = row + x;
        if (!mask[index]) continue;
        const root = find(index);
        let label = rootToLabel.get(root);
        if (label === undefined) {
          nextLabel += 1;
          label = nextLabel;
          rootToLabel.set(root, label);
          regions.push({
            label: label,
            area: 0,
            minX: x,
            minY: y,
            maxX: x,
            maxY: y,
          });
        }
        labels[index] = label;
        const region = regions[label - 1];
        region.area += 1;
        if (x < region.minX) region.minX = x;
        if (x > region.maxX) region.maxX = x;
        if (y < region.minY) region.minY = y;
        if (y > region.maxY) region.maxY = y;
      }
    }

    return { labels: labels, regions: regions };
  }

  function summarizeRegions(regions, labels, gray, alpha, width) {
    const summaries = new Array(regions.length);
    for (let r = 0; r < regions.length; r += 1) {
      const region = regions[r];
      let sumGray = 0;
      let minGray = Infinity;
      let maxGray = -Infinity;
      let sumAlpha = 0;
      let transparentPixels = 0;
      for (let y = region.minY; y <= region.maxY; y += 1) {
        const row = y * width;
        for (let x = region.minX; x <= region.maxX; x += 1) {
          const index = row + x;
          if (labels[index] !== region.label) continue;
          const value = gray[index];
          sumGray += value;
          if (value < minGray) minGray = value;
          if (value > maxGray) maxGray = value;
          if (alpha) {
            const a = alpha[index];
            sumAlpha += a;
            if (a === 0) transparentPixels += 1;
          } else {
            sumAlpha += 255;
          }
        }
      }
      summaries[r] = {
        label: region.label,
        area: region.area,
        bbox: {
          x: region.minX,
          y: region.minY,
          width: region.maxX - region.minX + 1,
          height: region.maxY - region.minY + 1,
        },
        meanGray: region.area ? sumGray / region.area : 0,
        minGray: region.area ? minGray : 0,
        maxGray: region.area ? maxGray : 0,
        transparentPixels: transparentPixels,
        meanAlpha: region.area ? sumAlpha / region.area : 0,
      };
    }
    return summaries;
  }

  function statsRange(array) {
    if (!array || !array.length) return { min: 0, max: 0 };
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < array.length; i += 1) {
      const v = array[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { min: min, max: max };
  }

  // --- Orchestrator -------------------------------------------------------
  // emit(stage, payload) is awaited after each stage. shouldCancel() is polled
  // between row chunks. The returned buffers are freshly allocated per run.
  function runPipeline(image, rawParams, options) {
    let params;
    const opts = options || {};
    const shouldCancel = opts.shouldCancel || function () { return false; };
    const emit = opts.onStage || function () { return undefined; };

    // Parameter validation is folded into the promise chain so callers (the
    // worker runner in particular) always see a rejection, never a sync throw.
    return Promise.resolve()
      .then(function () {
        params = normalizeParams(rawParams);
        const width = image.width;
        const height = image.height;
        const count = image.pixelCount;
        if (
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width <= 0 ||
          height <= 0
        ) {
          throw new ImageFormatError('BAD_DIMENSION', '图像尺寸无效。');
        }
        if (!Number.isSafeInteger(count) || count !== width * height) {
          throw new ImageFormatError('DIMENSION_OVERFLOW', '图像像素数与尺寸不一致。');
        }
        if (!image.samples && !image.rgba) {
          throw new ImageFormatError('INVALID_INPUT', '图像缺少像素数据。');
        }
        return checkpoint(shouldCancel, 'grayscale');
      })
      .then(function () {
        return runStages(image, params, shouldCancel, emit);
      });
  }

  function runStages(image, params, shouldCancel, emit) {
    const width = image.width;
    const height = image.height;
    const count = image.pixelCount;

    return Promise.resolve().then(function () {
        // Stage 1 — grayscale.
        const gray = computeGrayscale(image);
        return Promise.resolve(
          emit('grayscale', { gray: gray })
        ).then(function () {
          return checkpoint(shouldCancel, 'grayscale');
        }).then(function () {
          return gray;
        });
      })
      .then(function (gray) {
        // Stage 2 — local contrast, chunked by rows for cancellation.
        const contrast = new Uint32Array(count);
        let yStart = 0;
        function step() {
          if (yStart >= height) {
            return Promise.resolve(
              emit('contrast', { gray: gray, contrast: contrast })
            ).then(function () {
              return { gray: gray, contrast: contrast };
            });
          }
          const yEnd = Math.min(height, yStart + CHUNK_ROWS);
          for (let y = yStart; y < yEnd; y += 1) {
            const y0 = y > 0 ? y - 1 : 0;
            const y2 = y + 1 < height ? y + 1 : height - 1;
            for (let x = 0; x < width; x += 1) {
              const x0 = x > 0 ? x - 1 : 0;
              const x2 = x + 1 < width ? x + 1 : width - 1;
              let min = Infinity;
              let max = -Infinity;
              for (let yy = y0; yy <= y2; yy += 1) {
                const row = yy * width;
                for (let xx = x0; xx <= x2; xx += 1) {
                  const value = gray[row + xx];
                  if (value < min) min = value;
                  if (value > max) max = value;
                }
              }
              contrast[y * width + x] = max - min;
            }
          }
          yStart = yEnd;
          return checkpoint(shouldCancel, 'contrast').then(step);
        }
        return step();
      })
      .then(function (stage2) {
        // Stage 3 — threshold.
        return checkpoint(shouldCancel, 'threshold').then(function () {
          const maskResult = computeMask(stage2.contrast, image, params);
          return Promise.resolve(
            emit('threshold', {
              gray: stage2.gray,
              contrast: stage2.contrast,
              mask: maskResult.mask,
              foreground: maskResult.foreground,
              cut: maskResult.cut,
            })
          ).then(function () {
            return {
              gray: stage2.gray,
              contrast: stage2.contrast,
              mask: maskResult.mask,
              foreground: maskResult.foreground,
              cut: maskResult.cut,
            };
          });
        });
      })
      .then(function (stage3) {
        // Stage 4 — labeling and summaries.
        return checkpoint(shouldCancel, 'labeling').then(function () {
          const labelled = labelRegions(stage3.mask, width, height);
          const summaries = summarizeRegions(
            labelled.regions,
            labelled.labels,
            stage3.gray,
            image.alpha,
            width
          );
          const grayRange = statsRange(stage3.gray);
          const summary = {
            width: width,
            height: height,
            pixelCount: count,
            maxValue: image.maxValue,
            bitsPerSample: image.bitsPerSample,
            threshold: params.threshold,
            cut: stage3.cut,
            foreground: stage3.foreground,
            regionCount: summaries.length,
            regions: summaries,
            grayRange: grayRange,
            alphaRange: image.alpha ? statsRange(image.alpha) : null,
          };
          const result = {
            gray: stage3.gray,
            contrast: stage3.contrast,
            mask: stage3.mask,
            labels: labelled.labels,
            summary: summary,
          };
          return Promise.resolve(
            emit('labeling', result, { final: true })
          ).then(function () {
            return result;
          });
        });
      });
  }

  // Overlay palette: a stable label -> color mapping. Label 0 is transparent
  // so untouched source pixels remain visible underneath.
  function colorForLabel(label) {
    if (!label) return [0, 0, 0, 0];
    const hue = (label * 0.618033988749895) % 1;
    const rgb = hslToRgb(hue, 0.62, 0.56);
    return [rgb[0], rgb[1], rgb[2], 255];
  }

  function hslToRgb(h, s, l) {
    function hue2rgb(p, q, t) {
      let tt = t;
      if (tt < 0) tt += 1;
      if (tt > 1) tt -= 1;
      if (tt < 1 / 6) return p + (q - p) * 6 * tt;
      if (tt < 1 / 2) return q;
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
      return p;
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  // Builds a display overlay from labels. Deterministic for identical labels.
  function buildOverlay(labels, width, height) {
    const count = width * height;
    const rgba = new Uint8ClampedArray(count * 4);
    for (let i = 0; i < count; i += 1) {
      const color = colorForLabel(labels[i]);
      const o = i * 4;
      rgba[o] = color[0];
      rgba[o + 1] = color[1];
      rgba[o + 2] = color[2];
      rgba[o + 3] = color[3];
    }
    return rgba;
  }

  return {
    STAGES,
    DEFAULT_PARAMS,
    normalizeParams,
    computeGrayscale,
    computeLocalContrast,
    computeMask,
    labelRegions,
    summarizeRegions,
    runPipeline,
    colorForLabel,
    buildOverlay,
    statsRange,
  };
});
