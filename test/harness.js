// A minimal offline test harness. No third-party dependencies: Node's own
// `node:test` runner plus a tiny assertion helper and a fake Worker that can
// deliver messages out of order.
//
// The tests import the same files the browser loads (via CommonJS UMD), so a
// change that only fixes one module while breaking the others will fail here.

'use strict';

const assert = require('node:assert/strict');

const core = {
  errors: require('../src/core/errors.js'),
  limits: require('../src/core/limits.js'),
  parser: require('../src/core/parser.js'),
  compute: require('../src/core/compute.js'),
  exporter: require('../src/core/exporter.js'),
  runner: require('../src/worker/runner.js'),
  controller: require('../src/app/controller.js'),
  fixtures: require('../src/app/fixtures.js'),
};

// Records every message the runner posts, in order, with its jobVersion.
function createRecordingSink() {
  const messages = [];
  return {
    messages,
    post(message, transfer) {
      messages.push({ message, transfer: transfer || null });
    },
    byVersion(version) {
      return messages.filter((entry) => entry.message.jobVersion === version);
    },
    stages(version) {
      return messages
        .filter((entry) => entry.message.type === 'stage')
        .filter((entry) => entry.message.jobVersion === version)
        .map((entry) => entry.message.stage);
    },
  };
}

// Runs a job to completion in-process (no timers beyond the pipeline's own
// yielding) and returns { messages, result }.
async function runJobInProcess(image, params, options) {
  const sink = createRecordingSink();
  const opts = options || {};
  let cancelFns = opts.cancelAfter || null;
  const version = opts.jobVersion == null ? 1 : opts.jobVersion;
  let cancelled = false;
  const result = await core.runner.runJob(
    {
      type: 'run',
      jobVersion: version,
      image: core.parser.toTransferable(image),
      params: params || {},
    },
    {
      post: sink.post,
      isCancelled() {
        if (cancelled) return true;
        if (cancelFns && cancelFns(messageCount(sink))) {
          cancelled = true;
          return true;
        }
        return false;
      },
    }
  );
  return { messages: sink.messages, stages: sink.stages(version), result };
}

function messageCount(sink) {
  return sink.messages.length;
}

// Fake Worker: captures postMessage calls and lets a test push messages back
// in any order. Each instance records its own generation for stale checks.
function createFakeWorkerFactory() {
  const created = [];
  function factory() {
    const worker = {
      id: created.length + 1,
      posted: [],
      terminated: 0,
      _onmessage: null,
      _onerror: null,
      postMessage(message) {
        this.posted.push(message);
      },
      terminate() {
        this.terminated += 1;
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
      // Test helpers.
      emit(message) {
        if (this._onmessage) this._onmessage({ data: message });
      },
      emitRaw(data) {
        if (this._onmessage) this._onmessage({ data });
      },
      fail(message) {
        if (this._onerror) this._onerror({ message });
      },
    };
    created.push(worker);
    return worker;
  }
  return { factory, created };
}

function makeController(fake) {
  const snapshots = [];
  const controller = core.controller.createController({
    workerFactory: fake.factory,
    onChange(snap) {
      snapshots.push(snap);
    },
    now() {
      return 1234567890;
    },
  });
  return { controller, snapshots };
}

module.exports = {
  assert,
  core,
  createRecordingSink,
  runJobInProcess,
  createFakeWorkerFactory,
  makeController,
};
