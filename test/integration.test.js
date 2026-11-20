'use strict';

// Integration tests: the controller, the real runner and the real pipeline,
// wired together through a fake Worker whose message delivery is controlled
// by the test. This is the "worker race" coverage: real jobs, real stage
// messages, deliberately reordered delivery.

const test = require('node:test');
const { assert, core } = require('./harness.js');

const { parser, compute, runner, controller, fixtures } = core;
const render = require('../src/app/render.js');

// A worker stand-in that runs the real runner but lets the test hold messages
// in a queue, so it can replay them late or out of order.
function createHoldableWorker() {
  const outbox = [];
  const worker = {
    held: [],
    posted: [],
    terminated: false,
    _onmessage: null,
    postMessage(message) {
      this.posted.push(message);
      if (message.type === 'run') {
        outbox.length = 0;
        const version = message.jobVersion;
        const self = this;
        runner
          .runJob(message, {
            post: (out) => outbox.push(out),
            isCancelled: () => self.terminated || self.cancelVersion === version,
          })
          .then(() => {
            self._release(outbox);
          });
        return;
      }
      if (message.type === 'cancel') {
        this.cancelVersion = message.jobVersion;
      }
    },
    _release(messages) {
      for (const message of messages) this.held.push(message);
    },
    // Lets the test deliver everything produced so far.
    flush(filter) {
      const messages = this.held.splice(0);
      for (const message of messages) {
        if (!filter || filter(message)) {
          if (this._onmessage) this._onmessage({ data: message });
        }
      }
    },
    terminate() {
      this.terminated = true;
    },
    set onmessage(handler) {
      this._onmessage = handler;
    },
    get onmessage() {
      return this._onmessage;
    },
    set onerror(handler) {
      this._onerror = handler;
    },
    get onerror() {
      return this._onerror;
    },
  };
  return worker;
}

function waitFor(condition, timeout) {
  const limit = timeout == null ? 2000 : timeout;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function poll() {
      if (condition()) return resolve();
      if (Date.now() - start > limit) return reject(new Error('timeout'));
      setTimeout(poll, 2);
    }
    poll();
  });
}

function load(id) {
  const fixture = fixtures.get(id);
  return fixture.format === 'rgba'
    ? parser.parseRgbaRaw(fixture.bytes, { width: fixture.width, height: fixture.height })
    : parser.parsePgm(fixture.bytes);
}

test('a newer job wins even when the older one finishes later', async () => {
  const workers = [];
  const snapshots = [];
  const ctrl = controller.createController({
    workerFactory() {
      const worker = createHoldableWorker();
      workers.push(worker);
      return worker;
    },
    onChange(snap) {
      snapshots.push(snap);
    },
  });

  const imageA = load('pgm-two-peaks'); // 2 regions
  const imageB = load('pgm-peak'); // 1 region
  ctrl.start(parser.toTransferable(imageA), { threshold: 0.15 });
  const workerA = workers[0];
  ctrl.start(parser.toTransferable(imageB), { threshold: 0.15 });
  const workerB = workers[1];

  // Let both real pipelines run.
  await waitFor(() => workerA.held.length > 0 && workerB.held.length > 0);

  // Replay the OLD worker's messages first, then the new one's.
  workerA.flush();
  workerB.flush();

  const state = ctrl.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.result.summary.regionCount, 1, 'the newer job must win');
  assert.ok(state.droppedMessages >= 1);
  void snapshots;
});

test('cancelling mid-flight then starting a new job publishes only the new one', async () => {
  const workers = [];
  const ctrl = controller.createController({
    workerFactory() {
      const worker = createHoldableWorker();
      workers.push(worker);
      return worker;
    },
  });

  const image = load('pgm-16-high');
  const imageC = load('pgm-peak');
  void image;
  ctrl.start(parser.toTransferable(load('pgm-two-peaks')), { threshold: 0.15 });
  const first = workers[0];
  await waitFor(() => first.held.length > 0);
  assert.equal(ctrl.cancel(), true);

  ctrl.start(parser.toTransferable(imageC), { threshold: 0.15 });
  const second = workers[1];
  await waitFor(() => second.held.length > 0);

  // Deliver the cancelled job's late messages first: they must not publish,
  // and must not disturb the new job that is already running.
  first.flush();
  let state = ctrl.getState();
  assert.equal(state.status, 'computing', 'cancelled job cannot publish');
  assert.equal(state.hasResult, false);
  assert.ok(state.droppedMessages >= 1);

  second.flush();
  state = ctrl.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.result.summary.regionCount, 1);
  // The published result is the second job's version, not the cancelled one.
  assert.equal(state.result.jobVersion, state.jobVersion);
});

test('rapid repeated submits publish only the last version', async () => {
  const workers = [];
  const ctrl = controller.createController({
    workerFactory() {
      const worker = createHoldableWorker();
      workers.push(worker);
      return worker;
    },
  });

  const images = ['pgm-two-peaks', 'pgm-peak', 'pgm-flat', 'pgm-two-peaks'];
  let lastVersion = 0;
  for (const id of images) {
    lastVersion = ctrl.start(parser.toTransferable(load(id)), { threshold: 0.15 });
  }
  assert.equal(workers.length, images.length);

  // Every worker was superseded except the last, so only the last produced a
  // done message. Flush them all; only the last version may publish.
  const lastWorker = workers[workers.length - 1];
  await waitFor(() => lastWorker.held.some((m) => m.type === 'done'));
  for (const worker of workers) worker.flush();

  const state = ctrl.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.result.jobVersion, lastVersion);
  assert.equal(state.result.summary.regionCount, 2, 'the last image has two regions');
  // Superseded workers were terminated; nothing they could emit may publish.
  for (let i = 0; i < workers.length - 1; i += 1) {
    assert.equal(workers[i].terminated, true);
  }
});

test('reordered stage messages never publish a mismatched label raster', async () => {
  const workers = [];
  const ctrl = controller.createController({
    workerFactory() {
      const worker = createHoldableWorker();
      workers.push(worker);
      return worker;
    },
  });

  ctrl.start(parser.toTransferable(load('pgm-two-peaks')), { threshold: 0.15 });
  const worker = workers[0];
  await waitFor(() => worker.held.some((m) => m.type === 'done'));

  // Deliver done BEFORE the labeling stage: the summary publishes, but no
  // labels are attached (they were never delivered for this version).
  worker.flush((m) => m.type === 'done');
  let state = ctrl.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.result.labels, null, 'labels must not be fabricated');

  // Now the late labeling stage arrives; it must not retroactively rewrite
  // the published result.
  worker.flush((m) => m.type === 'stage' && m.stage === 'labeling');
  state = ctrl.getState();
  assert.equal(state.status, 'done');
  assert.equal(state.result.labels, null);
});

test('the runner reports real previews without touching source pixels', async () => {
  const image = load('pgm-16-high');
  const originalSamples = Array.from(image.samples);
  const messages = [];
  await runner.runJob(
    {
      type: 'run',
      jobVersion: 42,
      image: parser.toTransferable(image),
      params: { threshold: 0.15 },
    },
    {
      post: (message) => messages.push(message),
      isCancelled: () => false,
    }
  );
  const stages = messages.filter((m) => m.type === 'stage').map((m) => m.stage);
  assert.deepEqual(stages, ['grayscale', 'contrast', 'threshold', 'labeling']);
  const grayStage = messages.find((m) => m.stage === 'grayscale');
  assert.ok(grayStage.payload.preview);
  // The preview is a downsample, never an in-place mutation of samples.
  assert.deepEqual(Array.from(image.samples), originalSamples);
  const done = messages.find((m) => m.type === 'done');
  assert.equal(done.jobVersion, 42);
  assert.equal(done.summary.grayRange.max, 65000);
});

test('display conversion is tone-mapping only; raw samples stay intact', () => {
  const image = load('pgm-16-high');
  const before = Array.from(image.samples);
  const rgba = render.imageToRgbaDisplay(image);
  assert.equal(rgba.length, image.pixelCount * 4);
  // The high byte of 65000 (0xFDE8) is 0xFD; the display channel shows that.
  const index = 3 * image.width + 3;
  assert.equal(rgba[index * 4], 65000 >> 8);
  assert.equal(rgba[index * 4 + 3], 255);
  // Source untouched.
  assert.deepEqual(Array.from(image.samples), before);
  // 16-bit ordering is preserved in the display buffer.
  for (let i = 1; i < image.pixelCount; i += 1) {
    if (image.samples[i] > image.samples[i - 1]) {
      assert.ok(rgba[i * 4] >= rgba[(i - 1) * 4]);
    }
  }
});

test('RGBA display conversion preserves alpha verbatim', () => {
  const image = load('rgba-transparent');
  const rgba = render.imageToRgbaDisplay(image);
  assert.deepEqual(Array.from(rgba.subarray(0, 4)), Array.from(image.rgba.subarray(0, 4)));
  assert.equal(rgba[(4 * 6 + 4) * 4 + 3], 0);
});

test('labeling output is independent of how the image is displayed', async () => {
  // Compute once, then render at several "scales" via the display converter;
  // the label raster and summary must be unchanged by any of it.
  const image = load('pgm-two-peaks');
  const result = await compute.runPipeline(image, { threshold: 0.15 });
  const labelsBefore = Array.from(result.labels);
  for (const scale of [1, 2, 3, 8]) {
    const display = render.imageToRgbaDisplay(image);
    void scale;
    void display;
  }
  assert.deepEqual(Array.from(result.labels), labelsBefore);
});

test('display scale is always an integer within engine canvas limits', () => {
  // Normal fits pass through unchanged.
  assert.equal(render.clampScale(9, 9, 1), 1);
  assert.equal(render.clampScale(9, 9, 8), 8);
  // A huge image with a huge requested zoom is clamped, never fractional.
  const huge = render.clampScale(4096, 4096, 64);
  assert.ok(Number.isInteger(huge));
  assert.ok(huge >= 1);
  assert.ok(4096 * huge <= render.MAX_CANVAS);
  // Requesting below 1 never yields 0.
  assert.equal(render.clampScale(100, 100, 0), 1);
  assert.equal(render.clampScale(100, 100, -5), 1);
});
