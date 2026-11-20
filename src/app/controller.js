// Main-thread job controller. It owns job versioning and is deliberately
// transport-agnostic: the browser passes a real Worker factory, the tests pass
// fake workers that can deliver messages out of order.
//
// Guarantees enforced here (and covered by the offline tests):
//   * every accepted message must carry the current jobVersion
//   * messages from a superseded worker generation are dropped even if their
//     jobVersion happens to match
//   * a late message from a cancelled/terminated worker never overwrites a
//     newer published result
//   * the previous published result is retained across cancel and failure
//
// State reported to the UI:
//   idle | parsing | computing | publishing | done | cancelled | failed

(function (root, factory) {
  'use strict';
  const api = factory();
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.controller = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STAGE_PHASES = {
    grayscale: 'computing',
    contrast: 'computing',
    threshold: 'computing',
    labeling: 'publishing',
  };
  const PHASES = ['idle', 'compute', 'computing', 'publishing', 'done'];
  const PHASE_RANK = PHASES.reduce(function (acc, name, index) {
    acc[name] = index;
    return acc;
  }, {});

  function createController(options) {    const opts = options || {};
    if (typeof opts.workerFactory !== 'function') {
      throw new Error('createController 需要 workerFactory');
    }
    const onChange = opts.onChange || function () {};
    const now =
      opts.now ||
      function () {
        return Date.now();
      };

    let jobVersion = 0;
    let generation = 0;
    let worker = null;
    let status = 'idle';
    let phase = 'idle';
    let lastError = null;
    let published = null; // most recent successful result (retained)
    let pendingLabels = null; // labels received for the in-flight version
    let pendingLabelsVersion = -1;
    let lastMessage = null;
    let droppedMessages = 0;

    function snapshot() {
      return {
        jobVersion: jobVersion,
        generation: generation,
        status: status,
        phase: phase,
        error: lastError,
        hasResult: Boolean(published),
        result: published,
        lastMessage: lastMessage,
        droppedMessages: droppedMessages,
      };
    }

    function emit(patch) {
      if (patch.status !== undefined) status = patch.status;
      if (patch.phase !== undefined) phase = patch.phase;
      if (patch.error !== undefined) lastError = patch.error;
      if (patch.result !== undefined) published = patch.result;
      if (patch.message !== undefined) lastMessage = patch.message;
      onChange(snapshot());
    }

    function destroyWorker() {
      if (!worker) return;
      try {
        worker.terminate();
      } catch (e) {
        /* ignore terminate failures */
      }
      worker = null;
    }

    function isCurrent(message, ownerGeneration) {
      return (
        ownerGeneration === generation &&
        message &&
        message.jobVersion === jobVersion
      );
    }

    function handleMessage(message, ownerGeneration) {
      if (!isCurrent(message, ownerGeneration)) {
        // Stale worker, stale version, or malformed message.
        droppedMessages += 1;
        emit({});
        return false;
      }
      if (message.type === 'stage') {
        // A terminal state is final for this version: a late queued stage
        // (possible with the in-page fallback's setTimeout queue) must not
        // move the status bar back from 完成/已取消/失败 to 计算中.
        if (status === 'cancelled' || status === 'failed' || status === 'done') {
          droppedMessages += 1;
          emit({});
          return false;
        }
        if (
          message.stage === 'labeling' &&
          message.payload &&
          message.payload.labels
        ) {
          // Stash the exact label raster for this version; it is only ever
          // paired with a summary carrying the same jobVersion.
          pendingLabels = message.payload.labels;
          pendingLabelsVersion = message.jobVersion;
        }
        // Stage phases never move backwards within a job, so a late
        // low-stage message cannot make the status bar look like the pipeline
        // went in reverse. The payload is still forwarded for the previews.
        const nextPhase = STAGE_PHASES[message.stage] || 'computing';
        if (PHASE_RANK[nextPhase] >= PHASE_RANK[phase]) phase = nextPhase;
        emit({
          status: 'computing',
          phase: phase,
          message: {
            stage: message.stage,
            jobVersion: message.jobVersion,
            payload: message.payload,
            at: now(),
          },
        });
        return true;
      }
      if (message.type === 'done') {
        // Publish only when this is still the newest job, and only hand the
        // UI label data that was produced by this exact version.
        const labels =
          pendingLabelsVersion === message.jobVersion ? pendingLabels : null;
        const result = {
          jobVersion: jobVersion,
          summary: message.summary,
          labels: labels,
          publishedAt: now(),
        };
        pendingLabels = null;
        pendingLabelsVersion = -1;
        phase = 'done';
        emit({
          status: 'done',
          phase: phase,
          error: null,
          result: result,
          message: { stage: 'done', jobVersion: message.jobVersion, at: now() },
        });
        destroyWorker();
        return true;
      }
      if (message.type === 'cancelled') {
        emit({ status: 'cancelled', phase: 'cancelled' });
        return true;
      }
      if (message.type === 'error') {
        emit({
          status: 'failed',
          phase: 'failed',
          error: message.error || { code: 'PIPELINE_FAILED' },
        });
        return true;
      }      droppedMessages += 1;
      emit({});
      return false;
    }

    function attach(instance, ownerGeneration) {
      instance.onmessage = function (event) {
        handleMessage(event && event.data, ownerGeneration);
      };
      instance.onerror = function (event) {
        if (ownerGeneration !== generation) return;
        emit({
          status: 'failed',
          phase: 'failed',
          error: {
            code: 'WORKER_FAILED',
            message: (event && event.message) || 'Worker 异常。',
            userMessage: '计算 Worker 异常退出。',
          },
        });
        destroyWorker();
      };
    }

    // Starts a new job. Any in-flight job is invalidated synchronously: its
    // version no longer matches, so late messages are dropped.
    function start(imagePayload, params) {
      jobVersion += 1;
      generation += 1;
      const version = jobVersion;
      const ownerGeneration = generation;
      destroyWorker();
      pendingLabels = null;
      pendingLabelsVersion = -1;
      lastError = null;
      phase = 'compute';
      emit({ status: 'computing', phase: phase, error: null });

      let instance;
      try {
        instance = opts.workerFactory();
      } catch (error) {
        emit({
          status: 'failed',
          phase: 'failed',
          error: {
            code: 'WORKER_FAILED',
            message: (error && error.message) || '无法创建 Worker。',
            userMessage: '无法创建计算 Worker，请检查浏览器支持。',
          },
        });
        return version;
      }
      worker = instance;
      attach(instance, ownerGeneration);
      instance.postMessage({
        type: 'run',
        jobVersion: version,
        image: imagePayload,
        params: params || {},
      });
      return version;
    }

    function cancel() {
      if (status === 'done' || status === 'cancelled' || status === 'failed') {
        return false;
      }
      // Invalidate first, then tell the worker (if it is still alive) so the
      // result is ignored even if the message races the terminate().
      const cancelledVersion = jobVersion;
      jobVersion += 1;
      generation += 1;
      if (worker) {
        try {
          worker.postMessage({ type: 'cancel', jobVersion: cancelledVersion });
        } catch (e) {
          /* ignore */
        }
      }
      destroyWorker();
      emit({ status: 'cancelled', phase: 'cancelled' });
      return true;
    }

    function dispose() {
      jobVersion += 1;
      generation += 1;
      destroyWorker();
      status = 'idle';
      phase = 'idle';
    }

    return {
      start: start,
      cancel: cancel,
      dispose: dispose,
      getState: snapshot,
      // Exposed for tests that need to simulate a worker message directly.
      _handleMessage: handleMessage,
    };
  }

  return { createController };
});
