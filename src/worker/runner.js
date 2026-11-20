// Job runner shared by the real Worker and the in-page fallback worker.
// It owns the worker-side protocol: version-tagged stage messages, a final
// labeling message with transferable buffers, and a single terminal message.
//
// hooks.post(message)        — deliver a message to the main thread
// hooks.isCancelled()        — polled between stages/chunks
// hooks.transferList         — optional array of transferables per post

(function (root, factory) {
  'use strict';
  let compute;
  let errors;
  if (typeof module === 'object' && module.exports) {
    compute = require('../core/compute.js');
    errors = require('../core/errors.js');
  } else {
    compute = root.IWCore.compute;
    errors = root.IWCore.errors;
  }
  const api = factory(compute, errors);
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.runner = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (compute, errors) {
  'use strict';

  const PREVIEW_MAX = 160;

  // Nearest-neighbour downsample into an 8-bit display preview. Never mutates
  // the source buffer; it only reads samples.
  function makePreview(source, width, height, scaleToByte) {
    if (!source || !width || !height) return null;
    const step = Math.max(1, Math.ceil(Math.max(width, height) / PREVIEW_MAX));
    const outW = Math.max(1, Math.ceil(width / step));
    const outH = Math.max(1, Math.ceil(height / step));
    const data = new Uint8Array(outW * outH);
    for (let y = 0; y < outH; y += 1) {
      const sy = Math.min(height - 1, y * step);
      for (let x = 0; x < outW; x += 1) {
        const sx = Math.min(width - 1, x * step);
        data[y * outW + x] = scaleToByte(source[sy * width + sx]);
      }
    }
    return { width: outW, height: outH, step: step, data: data };
  }

  function makeLabelPreview(labels, width, height) {
    const step = Math.max(1, Math.ceil(Math.max(width, height) / PREVIEW_MAX));
    const outW = Math.max(1, Math.ceil(width / step));
    const outH = Math.max(1, Math.ceil(height / step));
    const data = new Uint8Array(outW * outH);
    for (let y = 0; y < outH; y += 1) {
      const sy = Math.min(height - 1, y * step);
      for (let x = 0; x < outW; x += 1) {
        const sx = Math.min(width - 1, x * step);
        // Labels beyond 255 are clamped for the low-res preview only; the
        // full Int32 label raster is transferred verbatim.
        data[y * outW + x] = Math.min(255, labels[sy * width + sx]);
      }
    }
    return { width: outW, height: outH, step: step, data: data };
  }

  function stageMessage(version, stage, payload) {
    return {
      type: 'stage',
      jobVersion: version,
      stage: stage,
      payload: payload,
    };
  }

  // image: transferable image payload from parser.toTransferable().
  // Returns a promise that resolves to the pipeline result (worker-side).
  function runJob(job, hooks) {
    // `post` may accept an optional transfer list; the worker uses it to hand
    // the full label raster over without a structured-clone copy.
    const postRaw = hooks.post;
    const post = function (message) {
      if (hooks.transferFor) {
        const list = hooks.transferFor(message);
        if (list && list.length) return postRaw(message, list);
      }
      return postRaw(message);
    };
    const isCancelled = hooks.isCancelled || function () { return false; };
    const version = job.jobVersion;
    const image = job.image;
    const params = job.params || {};
    const maxValue = image.maxValue || 255;

    function scaleToByte(value) {
      return Math.max(0, Math.min(255, Math.round((value / maxValue) * 255)));
    }

    const onStage = function (stage, payload) {
      if (isCancelled()) return undefined;
      if (stage === 'grayscale') {
        post(
          stageMessage(version, stage, {
            grayRange: compute.statsRange(payload.gray),
            preview: makePreview(payload.gray, image.width, image.height, scaleToByte),
          })
        );
        return undefined;
      }
      if (stage === 'contrast') {
        post(
          stageMessage(version, stage, {
            contrastRange: compute.statsRange(payload.contrast),
            preview: makePreview(payload.contrast, image.width, image.height, function (v) {
              return Math.max(0, Math.min(255, Math.round((v / maxValue) * 255)));
            }),
          })
        );
        return undefined;
      }
      if (stage === 'threshold') {
        post(
          stageMessage(version, stage, {
            foreground: payload.foreground,
            cut: payload.cut,
            maskPreview: makePreview(payload.mask, image.width, image.height, function (v) {
              return v ? 255 : 0;
            }),
          })
        );
        return undefined;
      }
      return undefined;
    };

    return compute
      .runPipeline(image, params, { shouldCancel: isCancelled, onStage: onStage })
      .then(function (result) {
        if (isCancelled()) {
          post({
            type: 'cancelled',
            jobVersion: version,
            message: '计算已取消。',
          });
          return null;
        }
        const preview = makeLabelPreview(result.labels, image.width, image.height);
        post({
          type: 'stage',
          jobVersion: version,
          stage: 'labeling',
          payload: {
            labels: result.labels,
            summary: result.summary,
            labelPreview: preview,
          },
        });
        post({
          type: 'done',
          jobVersion: version,
          summary: result.summary,
        });
        return result;
      })
      .catch(function (error) {
        if (isCancelled() || (error && error.code === 'PIPELINE_CANCELLED')) {
          post({
            type: 'cancelled',
            jobVersion: version,
            message: '计算已取消。',
          });
          return null;
        }
        post({
          type: 'error',
          jobVersion: version,
          phase: 'compute',
          error: errors.toErrorPayload(error, 'PIPELINE_FAILED'),
        });
        return null;
      });
  }

  return {
    PREVIEW_MAX,
    makePreview,
    makeLabelPreview,
    runJob,
  };
});
