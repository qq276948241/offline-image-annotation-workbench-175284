// Classic Web Worker entry. Loaded via `new Worker('src/worker/worker.js')`.
// Classic (non-module) workers are used so the app also works from file://
// in browsers that refuse module workers there.

/* global importScripts, IWCore, self */

importScripts(
  '../core/errors.js',
  '../core/compute.js',
  './runner.js'
);

var currentVersion = -1;

function isCancelled() {
  return currentVersion === -1;
}

self.onmessage = function (event) {
  var data = event.data || {};
  if (data.type === 'cancel') {
    // Invalidate whichever job is in flight. The runner polls this between
    // chunks and will report a `cancelled` message tagged with its own version.
    if (currentVersion !== -1 && data.jobVersion !== undefined && data.jobVersion !== currentVersion) {
      return;
    }
    currentVersion = -1;
    return;
  }
  if (data.type !== 'run') return;

  var version = data.jobVersion;
  currentVersion = version;

  IWCore.runner.runJob(data, {
    post: function (message, transfer) {
      if (transfer && transfer.length) self.postMessage(message, transfer);
      else self.postMessage(message);
    },
    transferFor: function (message) {
      if (message && message.type === 'stage' && message.stage === 'labeling' && message.payload && message.payload.labels) {
        return [message.payload.labels.buffer];
      }
      return null;
    },
    isCancelled: function () {
      return currentVersion !== version;
    },
  });
};
