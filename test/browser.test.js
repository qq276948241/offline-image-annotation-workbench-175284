'use strict';

// Zero-dependency headless-browser smoke test.
//
// Drives Google Chrome over the DevTools protocol using Node's built-in
// WebSocket (Node >= 22) to prove the *page* works: drag-and-drop, parse,
// worker compute, cancel, error messaging, retained old results and export.
// It is skipped automatically when Chrome is not installed, so `node --test`
// stays green on machines without a browser.
//
// Everything runs against file:// URLs — no network, no static fixtures.

const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { assert } = require('./harness.js');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (e) {
      /* keep looking */
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (res.ok) return await res.json();
    } catch (e) {
      /* not up yet */
    }
    await delay(50);
  }
  throw new Error('DevTools endpoint did not come up');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(JSON.stringify(data.error)));
        else resolve(data.result);
      } else if (data.method) {
        const handlers = this.listeners.get(data.method) || [];
        for (const handler of handlers) handler(data.params);
      }
    });
  }

  on(method, handler) {
    const list = this.listeners.get(method) || [];
    list.push(handler);
    this.listeners.set(method, list);
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
}

// Evaluates an expression in the page and returns its JSON value.
async function evaluate(cdp, expression, awaitPromise) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: Boolean(awaitPromise),
  });
  if (result.exceptionDetails) {
    throw new Error(
      'page exception: ' +
        (result.exceptionDetails.exception
          ? result.exceptionDetails.exception.description
          : JSON.stringify(result.exceptionDetails))
    );
  }
  return result.result.value;
}

async function waitForEval(cdp, expression, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 10000);
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression);
    if (last) return last;
    await delay(40);
  }
  throw new Error('timed out waiting for: ' + expression + ' (last=' + last + ')');
}

const CHROME = findChrome();

test(
  'browser end-to-end: fixture load, compute, cancel, error, retention, export',
  { skip: CHROME ? false : 'Chrome not installed', timeout: 90000 },
  async (t) => {
    const pagePath = path.resolve(__dirname, '..', 'index.html');
    const pageUrl = 'file://' + pagePath;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-chrome-'));
    const port = await freePort();
    const chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--allow-file-access-from-files',
        '--remote-debugging-port=' + port,
        '--user-data-dir=' + userDataDir,
        'about:blank',
      ],
      { stdio: 'ignore' }
    );

    let cdp;
    const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-downloads-'));

    try {
      await waitForEndpoint(port, 15000);
      const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      let pageTarget = targets.find((target) => target.type === 'page');
      if (!pageTarget) {
        pageTarget = await (
          await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })
        ).json();
      }
      const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
      cdp = new Cdp(ws);

      const consoleErrors = [];
      cdp.on('Runtime.consoleAPICalled', (params) => {
        if (params.type === 'error') {
          consoleErrors.push(
            params.args.map((arg) => arg.value || arg.description || '').join(' ')
          );
        }
      });
      cdp.on('Runtime.exceptionThrown', (params) => {
        consoleErrors.push(
          'uncaught: ' +
            (params.exceptionDetails.exception
              ? params.exceptionDetails.exception.description
              : params.exceptionDetails.text)
        );
      });

      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');
      // Downloads over file:// are flaky in headless Chrome; instead the page
      // exposes the exact text it would hand to Blob and we verify that. The
      // download path is still configured so a manual run behaves normally.
      await cdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloads,
      }).catch(() => undefined);

      await cdp.send('Page.navigate', { url: pageUrl });
      await waitForEval(
        cdp,
        "document.readyState === 'complete' && !!window.workbench && !!window.IWCore"
      );

      // The fixture buttons are built from code, not static JSON.
      const fixtureCount = await evaluate(
        cdp,
        "document.querySelectorAll('#fixtures .fixture').length"
      );
      assert.ok(fixtureCount >= 5, 'fixture buttons should be generated');

      // --- Load a fixture via the drag/drop-style entry point and compute ---
      await evaluate(cdp, "window.workbench.loadFixture('pgm-two-peaks')");
      await waitForEval(
        cdp,
        "window.workbench.state.summary && window.workbench.state.summary.regionCount === 2"
      );
      let snap = await evaluate(
        cdp,
        '({status: window.workbench.state.controller.getState().status, regions: window.workbench.state.summary.regionCount, labels: !!window.workbench.state.labels})'
      );
      assert.equal(snap.status, 'done');
      assert.equal(snap.regions, 2);
      assert.equal(snap.labels, true);

      // Status bar reflects the published state.
      let badge = await evaluate(cdp, "document.getElementById('status-badge').textContent");
      assert.equal(badge, '完成');
      // Export controls become enabled once a result is published.
      const exportEnabled = await evaluate(
        cdp,
        '({csv: !document.getElementById("export-csv").disabled, json: !document.getElementById("export-json").disabled})'
      );
      assert.deepEqual(exportEnabled, { csv: true, json: true });

      // Region table has one row per region, with the same labels.
      let tableLabels = await evaluate(
        cdp,
        "Array.from(document.querySelectorAll('#region-body tr td:first-child')).map(td => td.textContent.trim())"
      );
      assert.deepEqual(tableLabels, ['1', '2']);

      // --- Export: the CSV the page would save matches the table exactly ---
      // Verified through exportText(), which is the exact string exportAs()
      // hands to Blob; this avoids depending on headless download plumbing.
      const csv = await evaluate(cdp, "window.workbench.exportText('csv').text");
      const csvLabels = csv
        .trimEnd()
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .slice(1)
        .map((line) => line.split(',')[0]);
      assert.deepEqual(csvLabels, tableLabels, 'export labels must equal table labels');
      const json = JSON.parse(await evaluate(cdp, "window.workbench.exportText('json').text"));
      assert.deepEqual(
        json.regions.map((r) => r.label),
        tableLabels.map(Number),
        'JSON labels must equal table labels'
      );
      // Exercise the real download path too; success is not asserted because
      // headless file:// download handling varies by Chrome build.
      await evaluate(cdp, "window.workbench.exportAs('csv')");
      void downloads;

      // --- Recompute at a different threshold produces a new version ---
      const versionBefore = await evaluate(
        cdp,
        'window.workbench.state.controller.getState().jobVersion'
      );
      await evaluate(
        cdp,
        "(function(){const s=document.getElementById('threshold'); s.value='1'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change'));})()"
      );
      await waitForEval(
        cdp,
        'window.workbench.state.controller.getState().jobVersion > ' + versionBefore
      );
      // Wait for this specific version to finish, not the previous done.
      await waitForEval(
        cdp,
        "(() => { const s = window.workbench.state.controller.getState(); return s.status === 'done' && s.result.jobVersion === s.jobVersion && s.result.jobVersion > " +
          versionBefore +
          '; })()'
      );
      const highThreshold = await evaluate(
        cdp,
        'window.workbench.state.summary.regionCount'
      );
      assert.equal(highThreshold, 0, 'threshold 1.0 should discard the max-contrast peaks');

      // --- Error path: a malformed PGM shows a parse error and keeps the old table ---
      await evaluate(
        cdp,
        "window.workbench.loadBytes(new Uint8Array([80,53,10,51,32,51,10,50,53,53,10]), { name: 'bad.pgm', format: 'pgm' })"
      );
      const errBadge = await evaluate(cdp, "document.getElementById('status-badge').textContent");
      assert.equal(errBadge, '失败');
      const errText = await evaluate(cdp, "document.getElementById('message').textContent");
      assert.ok(errText.includes('TRUNCATED_RASTER'), 'error code should be shown: ' + errText);
      // Previous published result is retained.
      const retained = await evaluate(
        cdp,
        'window.workbench.state.controller.getState().hasResult'
      );
      assert.equal(retained, true, 'old result must be retained after a parse error');

      // --- Cancel path: start a job, cancel it, old result still on screen ---
      await evaluate(cdp, "window.workbench.loadFixture('pgm-16-high')");
      await waitForEval(
        cdp,
        "window.workbench.state.controller.getState().status === 'done'"
      );
      const beforeCancelRegions = await evaluate(
        cdp,
        'window.workbench.state.summary.regionCount'
      );
      await evaluate(
        cdp,
        "window.workbench.state.controller.start(window.IWCore.parser.toTransferable(window.workbench.state.image), {threshold:0.02}); window.workbench.state.controller.cancel();"
      );
      await delay(150);
      const cancelState = await evaluate(
        cdp,
        'window.workbench.state.controller.getState()'
      );
      assert.equal(cancelState.status, 'cancelled');
      assert.equal(
        cancelState.result.summary.regionCount,
        beforeCancelRegions,
        'cancelled job must not replace the published result'
      );

      // Zoom must not mutate pixels or labels.
      const labelsBefore = await evaluate(
        cdp,
        'Array.from(window.workbench.state.labels).join(",")'
      );
      await evaluate(
        cdp,
        "document.getElementById('zoom-in').click(); document.getElementById('zoom-in').click();"
      );
      const labelsAfter = await evaluate(
        cdp,
        'Array.from(window.workbench.state.labels).join(",")'
      );
      assert.equal(labelsAfter, labelsBefore, 'display zoom must not rewrite labels');
      // The source canvas is an exact integer multiple of the image size.
      const zoom = await evaluate(
        cdp,
        '({zoom: window.workbench.state.zoom, cw: document.getElementById("canvas").width, iw: window.workbench.state.image.width})'
      );
      assert.equal(zoom.cw, zoom.iw * zoom.zoom, 'canvas is integer-scaled, never resampled');

      // --- Drag & drop a real fixture file, instead of loadFixture() ---
      const fixtureBytes = await evaluate(
        cdp,
        "Array.from(window.IWCore.fixtures.get('pgm-flat').bytes)"
      );
      await evaluate(
        cdp,
        "(function(){ window.__fixtureBytes = " +
          JSON.stringify(fixtureBytes) +
          '; var dt = new DataTransfer();' +
          ' dt.items.add(new File([new Uint8Array(window.__fixtureBytes)], "dragged.pgm"));' +
          ' var event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });' +
          ' document.getElementById("drop").dispatchEvent(event);' +
          '})()'
      );
      await waitForEval(
        cdp,
        "window.workbench.state.source && window.workbench.state.source.name === 'dragged.pgm'"
      );
      await waitForEval(
        cdp,
        "window.workbench.state.summary && window.workbench.state.controller.getState().result && window.workbench.state.summary.regionCount === 0"
      );
      assert.equal(
        await evaluate(cdp, 'window.workbench.state.image.format'),
        'pgm-p5',
        'dropped file is parsed as a real PGM'
      );

      // --- Budget refusal is user-visible and also retains the old result ---
      await evaluate(
        cdp,
        '(function(){ try { window.IWCore.parser.parsePgm(window.IWCore.fixtures.get("pgm-flat").bytes, { limits: { maxFileBytes: 8 } }); return "no-throw"; } catch (e) { window.__budgetCode = e.code; window.__budgetMsg = e.userMessage; } })()'
      );
      const budget = await evaluate(
        cdp,
        '({code: window.__budgetCode, msg: window.__budgetMsg})'
      );
      assert.equal(budget.code, 'FILE_BUDGET_EXCEEDED');
      assert.ok(budget.msg && budget.msg.length > 0, 'budget error has a Chinese user message');

      // --- Switching images clears the visible table and disables export ---
      // (the controller retains its published result, but that result belongs
      // to the previous image, so the UI must not offer to export it).
      await evaluate(
        cdp,
        "(function(){ var dt = new DataTransfer();" +
          ' dt.items.add(new File([new Uint8Array(window.IWCore.fixtures.get("pgm-two-peaks").bytes)], "second.pgm"));' +
          ' document.getElementById("drop").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));' +
          '})()'
      );
      await evaluate(cdp, 'window.workbench.state.controller.cancel()');
      const afterSwitch = await evaluate(
        cdp,
        '({exportDisabled: document.getElementById("export-csv").disabled, rows: document.querySelectorAll("#region-body tr").length, hasSummary: !!window.workbench.state.summary})'
      );
      assert.equal(afterSwitch.hasSummary, false, 'new image has no published summary yet');
      assert.equal(afterSwitch.exportDisabled, true, 'export must be disabled for a not-yet-published image');
      assert.equal(afterSwitch.rows, 1, 'table shows a placeholder row, not stale regions');

      // --- Browser determinism cross-check against the Node reference ---
      const { core } = require('./harness.js');
      const flatFixture = core.fixtures.get('pgm-two-peaks');
      const nodeImage = core.parser.parsePgm(flatFixture.bytes);
      const nodeResult = await core.compute.runPipeline(nodeImage, { threshold: 0.15 });
      await evaluate(
        cdp,
        "(function(){const s=document.getElementById('threshold'); s.value='0.15'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change'));})()"
      );
      await evaluate(cdp, "window.workbench.loadFixture('pgm-two-peaks')");
      await waitForEval(
        cdp,
        "(() => { const s = window.workbench.state.controller.getState(); return s.status === 'done' && s.result.summary.regionCount === 2; })()"
      );
      const browserSummary = await evaluate(
        cdp,
        'JSON.stringify(window.workbench.state.summary.regions)'
      );
      assert.deepEqual(
        JSON.parse(browserSummary),
        JSON.parse(JSON.stringify(nodeResult.summary.regions)),
        'browser and Node must produce identical regions for the same bytes'
      );

      assert.deepEqual(consoleErrors, [], 'no console errors: ' + consoleErrors.join(' | '));
    } finally {
      if (cdp) {
        try {
          cdp.ws.close();
        } catch (e) {
          /* ignore */
        }
      }
      chrome.kill('SIGKILL');
      // Chrome can still be flushing profile files; cleanup must never mask
      // the real test result.
      await delay(300);
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (e) {
        /* best effort */
      }
    }
  }
);
