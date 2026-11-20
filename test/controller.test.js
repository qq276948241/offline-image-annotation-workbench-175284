'use strict';

const test = require('node:test');
const {
  assert,
  core,
  createFakeWorkerFactory,
  makeController,
} = require('./harness.js');

function fakeSummary(regionCount) {
  return {
    width: 4,
    height: 4,
    pixelCount: 16,
    maxValue: 255,
    bitsPerSample: 8,
    threshold: 0.15,
    cut: 38.25,
    foreground: regionCount * 9,
    regionCount: regionCount,
    regions: Array.from({ length: regionCount }, (_, i) => ({
      label: i + 1,
      area: 9,
      bbox: { x: 0, y: 0, width: 3, height: 3 },
      meanGray: 200,
      minGray: 0,
      maxGray: 255,
      transparentPixels: 0,
      meanAlpha: 255,
    })),
    grayRange: { min: 0, max: 255 },
    alphaRange: null,
  };
}

function labelsFor(size, value) {
  return new Int32Array(size).fill(value);
}

test('a newer job invalidates the older one; stale messages are dropped', () => {
  const fake = createFakeWorkerFactory();
  const { controller, snapshots } = makeController(fake);

  const v1 = controller.start({ width: 4, height: 4 }, {});
  const worker1 = fake.created[0];
  const v2 = controller.start({ width: 4, height: 4 }, {});
  const worker2 = fake.created[1];
  assert.equal(v2, v1 + 1);

  // The old worker is terminated and its messages are ignored even if the
  // fake still holds a reference and fires.
  assert.ok(worker1.terminated >= 1);
  worker1.emit({ type: 'stage', jobVersion: v1, stage: 'grayscale', payload: {} });
  worker1.emit({ type: 'done', jobVersion: v1, summary: fakeSummary(99) });
  assert.equal(controller.getState().hasResult, false, 'stale done must not publish');
  assert.ok(controller.getState().droppedMessages >= 1);

  // The current worker publishes normally.
  worker2.emit({ type: 'stage', jobVersion: v2, stage: 'labeling', payload: { labels: labelsFor(16, 1) } });
  worker2.emit({ type: 'done', jobVersion: v2, summary: fakeSummary(1) });
  const state = controller.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.result.jobVersion, v2);
  assert.equal(state.result.summary.regionCount, 1);
  void snapshots;
});

test('a message with a stale version from the current worker is dropped', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);
  const v1 = controller.start({}, {});
  const v2 = controller.start({}, {});
  const worker2 = fake.created[1];
  // Worker 2 replays a message tagged with the previous version.
  worker2.emit({ type: 'done', jobVersion: v1, summary: fakeSummary(5) });
  assert.equal(controller.getState().hasResult, false);
  worker2.emit({ type: 'done', jobVersion: v2, summary: fakeSummary(2) });
  assert.equal(controller.getState().result.jobVersion, v2);
});

test('cancellation drops late messages and retains the previous result', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);

  const v1 = controller.start({}, {});
  const w1 = fake.created[0];
  w1.emit({ type: 'stage', jobVersion: v1, stage: 'labeling', payload: { labels: labelsFor(16, 3) } });
  w1.emit({ type: 'done', jobVersion: v1, summary: fakeSummary(3) });
  assert.equal(controller.getState().result.summary.regionCount, 3);

  const v2 = controller.start({}, {});
  const w2 = fake.created[1];
  assert.equal(v2, v1 + 1);
  assert.equal(controller.cancel(), true);
  assert.equal(controller.getState().status, 'cancelled');

  // A late done from the cancelled job arrives after cancel(): ignored, and
  // the v1 result is still published.
  w2.emit({ type: 'stage', jobVersion: v2, stage: 'labeling', payload: { labels: labelsFor(16, 7) } });
  w2.emit({ type: 'done', jobVersion: v2, summary: fakeSummary(7) });
  const state = controller.getState();
  assert.equal(state.status, 'cancelled');
  assert.equal(state.result.jobVersion, v1, 'previous published result retained');
  assert.equal(state.result.summary.regionCount, 3);
  assert.ok(state.droppedMessages >= 2);
});

test('cancel is a no-op once a result is published', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);
  const v = controller.start({}, {});
  fake.created[0].emit({ type: 'done', jobVersion: v, summary: fakeSummary(1) });
  assert.equal(controller.cancel(), false);
  assert.equal(controller.getState().status, 'done');
});

test('a failed job keeps the previous result and reports the error', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);
  const v1 = controller.start({}, {});
  fake.created[0].emit({ type: 'done', jobVersion: v1, summary: fakeSummary(2) });

  const v2 = controller.start({}, {});
  fake.created[1].emit({
    type: 'error',
    jobVersion: v2,
    phase: 'compute',
    error: { code: 'PIPELINE_FAILED', message: 'boom', userMessage: '计算失败。' },
  });
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(state.error.code, 'PIPELINE_FAILED');
  assert.equal(state.result.jobVersion, v1, 'old result retained on failure');
});

test('worker.onerror is reported as WORKER_FAILED only for the current worker', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);
  const v1 = controller.start({}, {});
  const w1 = fake.created[0];
  controller.start({}, {});
  // The superseded worker erroring must not disturb the current job.
  w1.fail('old worker died');
  assert.notEqual(controller.getState().status, 'failed');
  fake.created[1].fail('current worker died');
  assert.equal(controller.getState().status, 'failed');
  assert.equal(controller.getState().error.code, 'WORKER_FAILED');
  void v1;
});

test('labels are only paired with the summary of the same version', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);
  const v1 = controller.start({}, {});
  const w1 = fake.created[0];
  w1.emit({ type: 'stage', jobVersion: v1, stage: 'labeling', payload: { labels: labelsFor(16, 4) } });
  // Interleave a second job before the first done; version 1's labels must
  // not leak into version 2's published result.
  const v2 = controller.start({}, {});
  const w2 = fake.created[1];
  w2.emit({ type: 'done', jobVersion: v2, summary: fakeSummary(1) });
  const state = controller.getState();
  assert.equal(state.result.jobVersion, v2);
  assert.equal(state.result.labels, null, 'no labels were produced for v2');
});

test('stage phases never move backwards within a job', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);
  const v = controller.start({}, {});
  const w = fake.created[0];
  w.emit({ type: 'stage', jobVersion: v, stage: 'labeling', payload: { labels: labelsFor(16, 1) } });
  assert.equal(controller.getState().phase, 'publishing');
  // A late low-stage message is still forwarded for previews, but the phase
  // stays at publishing so the status bar does not appear to rewind.
  w.emit({ type: 'stage', jobVersion: v, stage: 'contrast', payload: {} });
  assert.equal(controller.getState().phase, 'publishing');
  w.emit({ type: 'done', jobVersion: v, summary: fakeSummary(1) });
  assert.equal(controller.getState().status, 'done');
  assert.equal(controller.getState().phase, 'done');
});

test('a late stage message after done does not regress the status bar', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);
  const v = controller.start({}, {});
  const w = fake.created[0];
  w.emit({ type: 'stage', jobVersion: v, stage: 'labeling', payload: { labels: labelsFor(16, 1) } });
  w.emit({ type: 'done', jobVersion: v, summary: fakeSummary(1) });
  assert.equal(controller.getState().status, 'done');
  // A queued stage delivered after done must be ignored, not flip back to
  // computing (this can happen with the in-page fallback's setTimeout queue).
  w.emit({ type: 'stage', jobVersion: v, stage: 'contrast', payload: {} });
  const state = controller.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.phase, 'done');
  assert.equal(state.result.summary.regionCount, 1);
});

test('malformed messages do not throw and are counted as dropped', () => {
  const fake = createFakeWorkerFactory();
  const { controller } = makeController(fake);
  const v = controller.start({}, {});
  const w = fake.created[0];
  assert.doesNotThrow(() => w.emit(null));
  assert.doesNotThrow(() => w.emit({ type: 'unknown', jobVersion: v }));
  assert.ok(controller.getState().droppedMessages >= 2);
  // The job still accepts its real completion afterwards.
  w.emit({ type: 'done', jobVersion: v, summary: fakeSummary(0) });
  assert.equal(controller.getState().status, 'done');
});

test('workerFactory failure is surfaced as WORKER_FAILED, not a crash', () => {
  const controller = core.controller.createController({
    workerFactory() {
      throw new Error('Worker not allowed here');
    },
  });
  controller.start({}, {});
  const state = controller.getState();
  assert.equal(state.status, 'failed');
  assert.equal(state.error.code, 'WORKER_FAILED');
});
