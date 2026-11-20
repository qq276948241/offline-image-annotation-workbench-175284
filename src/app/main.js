// UI wiring. Parsing happens on the main thread (synchronous, budget-guarded,
// no large allocation before the budget checks); computation runs in a Worker
// through the versioned controller. If a Worker cannot be created (for example
// some file:// contexts), an in-page fallback runs the same runner.js so the
// demo still works — it uses the identical protocol and versioning.

/* global IWCore */

(function () {
  'use strict';

  const parser = IWCore.parser;
  const exporter = IWCore.exporter;
  const fixtures = IWCore.fixtures;
  const compute = IWCore.compute;
  const runner = IWCore.runner;
  const render = IWCore.render;

  const el = {
    drop: document.getElementById('drop'),
    file: document.getElementById('file'),
    rgbaWidth: document.getElementById('rgba-width'),
    rgbaHeight: document.getElementById('rgba-height'),
    fixtures: document.getElementById('fixtures'),
    threshold: document.getElementById('threshold'),
    thresholdValue: document.getElementById('threshold-value'),
    recompute: document.getElementById('recompute'),
    cancel: document.getElementById('cancel'),
    zoomIn: document.getElementById('zoom-in'),
    zoomOut: document.getElementById('zoom-out'),
    zoomPill: document.getElementById('zoom-pill'),
    toggleOverlay: document.getElementById('toggle-overlay'),
    stage: document.getElementById('stage'),
    canvasWrap: document.getElementById('canvas-wrap'),
    canvas: document.getElementById('canvas'),
    overlay: document.getElementById('overlay'),
    emptyNote: document.getElementById('empty-note'),
    imageInfo: document.getElementById('image-info'),
    regionBody: document.getElementById('region-body'),
    exportCsv: document.getElementById('export-csv'),
    exportJson: document.getElementById('export-json'),
    message: document.getElementById('message'),
    badge: document.getElementById('status-badge'),
    statusPhase: document.getElementById('status-phase'),
    statusVersion: document.getElementById('status-version'),
    statusDropped: document.getElementById('status-dropped'),
    statusPublished: document.getElementById('status-published'),
    prevGray: document.getElementById('prev-gray'),
    prevContrast: document.getElementById('prev-contrast'),
    prevMask: document.getElementById('prev-mask'),
    toast: document.getElementById('toast'),
  };

  const STATUS_LABELS = {
    idle: '空闲',
    parsing: '解析中',
    computing: '计算中',
    publishing: '发布中',
    done: '完成',
    cancelled: '已取消',
    failed: '失败',
  };

  // Phase names are the pipeline's own vocabulary; the status bar shows a
  // Chinese label so 解析 / 计算 / 发布 / 失败 are visually distinct.
  const PHASE_LABELS = {
    idle: '空闲',
    parse: '解析',
    compute: '计算',
    computing: '计算',
    publishing: '发布',
    done: '完成',
    cancelled: '已取消',
    failed: '失败',
  };

  const state = {
    image: null, // parsed image (main-thread copy, never mutated)
    source: null, // { name, format }
    labels: null, // labels belonging to the *published* result only
    stageLabels: new Map(), // jobVersion -> labels from the labeling stage
    summary: null, // published summary
    publishedOverlay: null,
    displayRgba: null,
    zoom: 1,
    fitScale: 1,
    overlayVisible: true,
    pendingJob: null,
    controller: null,
    workerMode: 'idle',
    workerBroken: false,
  };

  // --- messaging ---------------------------------------------------------

  let toastTimer = null;
  function toast(text) {
    el.toast.textContent = text;
    el.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('show');
    }, 1800);
  }

  function setMessage(kind, title, detail) {
    el.message.className = 'message ' + kind;
    el.message.innerHTML = '';
    const head = document.createElement('div');
    head.textContent = title;
    el.message.appendChild(head);
    if (detail) {
      const pre = document.createElement('pre');
      pre.textContent = detail;
      el.message.appendChild(pre);
    }
  }

  function renderStatusBar(snap) {
    const status = STATUS_LABELS[snap.status] || snap.status;
    el.badge.className = 'badge ' + snap.status;
    el.badge.textContent = status;
    el.statusPhase.textContent = PHASE_LABELS[snap.phase] || snap.phase || '—';
    el.statusVersion.textContent = String(snap.jobVersion);
    el.statusDropped.textContent = String(snap.droppedMessages);
    el.statusPublished.textContent = snap.hasResult
      ? 'v' + snap.result.jobVersion + ' · ' + snap.result.summary.regionCount + ' 区域'
      : '无';
    const busy = snap.status === 'computing';
    // Export/overlay are enabled only when a result is visible *for the image
    // currently on screen*. The controller retains a published result across
    // jobs, but after switching images that result belongs to the old image,
    // so exposing it would export one image's regions under another's name.
    const visible = Boolean(state.summary);
    el.recompute.disabled = !state.image || busy;
    el.cancel.disabled = !busy;
    el.exportCsv.disabled = !visible;
    el.exportJson.disabled = !visible;
    el.toggleOverlay.disabled = !visible;
  }

  function onControllerChange(snap) {
    // Publish first: applyPublished() updates state.summary, which the control
    // enable/disable logic in renderStatusBar reads.
    if (
      snap.status === 'done' &&
      snap.result &&
      snap.result.jobVersion === snap.jobVersion
    ) {
      applyPublished(snap.result);
    }
    renderStatusBar(snap);

    if (snap.lastMessage && snap.lastMessage.payload) {
      applyStage(snap.lastMessage.stage, snap.lastMessage.payload);
    }

    if (snap.status === 'cancelled') {
      setMessage('info', '已取消。', '保留上一次发布的结果；可重新计算。');
    } else if (snap.status === 'failed' && snap.error) {
      setMessage(
        'error',
        snap.error.userMessage || '计算失败。',
        (snap.error.code ? '[' + snap.error.code + '] ' : '') + (snap.error.message || '')
      );
    } else if (snap.status === 'done' && snap.result) {
      const summary = snap.result.summary;
      setMessage(
        'ok',
        '已完成 · v' + snap.result.jobVersion + ' · ' + summary.regionCount + ' 个区域',
        '前景像素 ' + summary.foreground + ' / ' + summary.pixelCount +
          '，阈值 ' + summary.threshold + '（cut=' + round(summary.cut) + '）'
      );
    }
  }

  function round(value) {
    return Math.round(value * 1000) / 1000;
  }

  function applyStage(stage, payload) {
    if (stage === 'grayscale' && payload.preview) {
      drawPreview(el.prevGray, payload.preview);
    } else if (stage === 'contrast' && payload.preview) {
      drawPreview(el.prevContrast, payload.preview);
    } else if (stage === 'threshold' && payload.maskPreview) {
      drawPreview(el.prevMask, payload.maskPreview, 'mask');
    }
  }

  function drawPreview(canvas, preview, colorize) {
    const imageData = render.previewToImageData(preview, colorize);
    if (!imageData) return;
    if (canvas.width !== preview.width || canvas.height !== preview.height) {
      canvas.width = preview.width;
      canvas.height = preview.height;
    }
    const ctx = canvas.getContext('2d');
    ctx.putImageData(imageData, 0, 0);
  }

  function applyPublished(result) {
    if (!result || !result.summary) return;
    state.summary = result.summary;
    // `result.labels` is guaranteed by the controller to belong to this exact
    // version, so the overlay can never show one job's regions next to
    // another job's table.
    state.labels = result.labels || null;
    state.publishedOverlay = null; // rebuilt lazily by drawLabelOverlay
    renderRegions(result.summary);
    drawLabelOverlay();
    toast('已发布 v' + result.jobVersion);
  }

  function renderRegions(summary) {
    const rows = exporter.regionRows(summary);
    if (!rows.length) {
      renderRegionsEmpty('未检测到区域（可能是平坦区或阈值过高）。');
      return;
    }
    el.regionBody.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const tr = document.createElement('tr');
      const color = compute.colorForLabel(row.label);
      tr.innerHTML =
        '<td><span class="swatch" style="background:rgb(' +
        color[0] + ',' + color[1] + ',' + color[2] + ')"></span>' + row.label + '</td>' +
        '<td>' + row.area + '</td>' +
        '<td>' + row.x + '</td>' +
        '<td>' + row.y + '</td>' +
        '<td>' + row.width + '</td>' +
        '<td>' + row.height + '</td>';
      frag.appendChild(tr);
    }
    el.regionBody.appendChild(frag);
  }

  // --- drawing -----------------------------------------------------------

  function computeFitScale(width, height) {
    const stageRect = el.stage.getBoundingClientRect();
    const availW = Math.max(1, stageRect.width - 32);
    const availH = Math.max(1, stageRect.height - 32);
    const fit = Math.min(availW / width, availH / height);
    return Math.max(1, Math.floor(fit));
  }

  function drawSource() {
    if (!state.image) return;
    const image = state.image;
    // The display RGBA is a pure function of the parsed image, so build it
    // once per image and reuse it for every zoom step.
    if (!state.displayRgba) state.displayRgba = render.imageToRgbaDisplay(image);
    state.zoom = render.clampScale(image.width, image.height, state.zoom);
    const scale = state.zoom;
    const ctx = el.canvas.getContext('2d');
    el.canvas.width = image.width * scale;
    el.canvas.height = image.height * scale;
    render.drawScaled(ctx, state.displayRgba, image.width, image.height, scale);
    el.overlay.width = el.canvas.width;
    el.overlay.height = el.canvas.height;
    el.zoomPill.textContent = '缩放 ' + scale + '×';
    drawLabelOverlay();
  }

  function drawLabelOverlay() {
    if (!state.image) return;
    const ctx = el.overlay.getContext('2d');
    ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    if (!state.overlayVisible || !state.labels || !state.summary) return;
    // `publishedOverlay` is a pure function of the label raster and is built
    // once per published result, so zoom steps only rescale it.
    if (!state.publishedOverlay) {
      state.publishedOverlay = compute.buildOverlay(
        state.labels,
        state.image.width,
        state.image.height
      );
    }
    render.drawOverlay(
      ctx,
      state.publishedOverlay,
      state.image.width,
      state.image.height,
      state.zoom,
      0.55
    );
  }

  function updateImageInfo() {
    const image = state.image;
    el.imageInfo.innerHTML = '';
    if (!image) {
      el.imageInfo.innerHTML = '<dt>状态</dt><dd>等待输入</dd>';
      return;
    }
    const entries = [
      ['来源', state.source ? state.source.name : '—'],
      ['格式', image.format + ' · ' + image.bitsPerSample + ' 位'],
      ['尺寸', image.width + ' × ' + image.height],
      ['像素数', String(image.pixelCount)],
      ['最大灰度', String(image.maxValue)],
      ['文件字节', String(image.fileBytes)],
      ['像素起点', String(image.pixelStart) + ' 字节'],
    ];
    if (image.kind === 'rgba') entries.push(['通道', 'RGBA（含 alpha）']);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < entries.length; i += 1) {
      const dt = document.createElement('dt');
      dt.textContent = entries[i][0];
      const dd = document.createElement('dd');
      dd.textContent = entries[i][1];
      frag.appendChild(dt);
      frag.appendChild(dd);
    }
    el.imageInfo.appendChild(frag);
  }

  // --- worker ------------------------------------------------------------

  // A real Worker is preferred. `new Worker(url)` almost never throws for a
  // missing script or a blocked file:// origin; that surfaces as an async
  // `error` event instead. So:
  //   * construction failure  -> fall back immediately
  //   * async boot failure    -> mark workers broken, so the *next* job uses
  //                              the in-page fallback (the current job still
  //                              reports WORKER_FAILED, which is truthful)
  // Both paths run the same runner.js, so the protocol and versioning are
  // identical either way.
  function makeWorkerFactory() {
    return function () {
      if (state.workerBroken) {
        state.workerMode = 'fallback';
        return createInlineWorker();
      }
      let worker;
      try {
        worker = new Worker('src/worker/worker.js');
      } catch (error) {
        state.workerBroken = true;
        state.workerMode = 'fallback';
        return createInlineWorker();
      }
      worker.addEventListener('error', function () {
        state.workerBroken = true;
      });
      state.workerMode = 'worker';
      return worker;
    };
  }

  // In-page fallback: a tiny object with the Worker surface, running the same
  // runner.js on the main thread via a microtask queue. Used only when a real
  // Worker cannot be constructed.
  function createInlineWorker() {
    const listeners = [];
    const selfLike = {
      onmessage: null,
    };
    const cancelFlag = { version: null, cancelled: false };
    function post(message) {
      for (let i = 0; i < listeners.length; i += 1) {
        const listener = listeners[i];
        setTimeout(function () {
          listener({ data: message });
        }, 0);
      }
    }
    const api = {
      postMessage: function (message) {
        if (message.type === 'cancel') {
          cancelFlag.cancelled = true;
          cancelFlag.version = message.jobVersion;
          return;
        }
        if (message.type === 'run') {
          cancelFlag.cancelled = false;
          cancelFlag.version = message.jobVersion;
          const myVersion = message.jobVersion;
          runner.runJob(message, {
            post: post,
            isCancelled: function () {
              return cancelFlag.cancelled || cancelFlag.version !== myVersion;
            },
          });
        }
      },
      terminate: function () {
        cancelFlag.cancelled = true;
      },
      addEventListener: function (type, listener) {
        if (type === 'message') listeners.push(listener);
      },
      set onmessage(handler) {
        selfLike.onmessage = handler;
        listeners.length = 0;
        if (handler) listeners.push(handler);
      },
      get onmessage() {
        return selfLike.onmessage;
      },
      onerror: null,
    };
    return api;
  }

  // --- input -------------------------------------------------------------

  function showParseError(error) {
    const payload = IWCore.errors.toErrorPayload(error, 'INVALID_INPUT');
    setMessage(
      'error',
      payload.userMessage,
      '[' + payload.code + '] ' + payload.message
    );
    el.badge.className = 'badge failed';
    el.badge.textContent = STATUS_LABELS.failed;
    el.statusPhase.textContent = PHASE_LABELS.parse;
    // Retain any previous result and image on screen.
    toast('解析失败：' + payload.userMessage);
  }

  function loadBytes(bytes, descriptor) {
    el.badge.className = 'badge parsing';
    el.badge.textContent = STATUS_LABELS.parsing;
    el.statusPhase.textContent = PHASE_LABELS.parse;
    let image;
    try {
      image = parser.parseImage(bytes, {
        kind: descriptor.format === 'rgba' ? 'rgba' : undefined,
        width: descriptor.width,
        height: descriptor.height,
        limits: descriptor.limits,
      });
    } catch (error) {
      showParseError(error);
      return false;
    }
    state.image = image;
    state.source = { name: descriptor.name, format: image.format };
    state.labels = null;
    state.summary = null;
    state.publishedOverlay = null;
    state.displayRgba = null;
    state.zoom = computeFitScale(image.width, image.height);
    state.fitScale = state.zoom;
    updateImageInfo();
    el.canvasWrap.hidden = false;
    el.emptyNote.hidden = true;
    // The visible table/overlay belongs to the previous image until the new
    // job publishes; clear it so what is shown always matches state.summary.
    renderRegionsEmpty('新图像计算中…');
    drawSource();
    startJob();
    return true;
  }

  function renderRegionsEmpty(text) {
    el.regionBody.innerHTML = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'hint';
    td.textContent = text;
    tr.appendChild(td);
    el.regionBody.appendChild(tr);
  }

  function startJob() {
    if (!state.image) return;
    if (!state.controller) {
      state.controller = IWCore.controller.createController({
        workerFactory: makeWorkerFactory(),
        onChange: onControllerChange,
      });
    }
    state.pendingJob = state.controller.start(
      parser.toTransferable(state.image),
      { threshold: Number(el.threshold.value) }
    );
    // `start()` already emitted a computing snapshot, but state.summary may
    // have been cleared since; refresh the controls against current state.
    renderStatusBar(state.controller.getState());
    setMessage('info', '计算中…', '任务版本 v' + state.pendingJob + '（' + state.workerMode + '）');
  }

  // --- export ------------------------------------------------------------

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function exportText(kind) {
    if (!state.summary) return null;
    const meta = {
      jobVersion: state.controller.getState().result
        ? state.controller.getState().result.jobVersion
        : null,
      format: state.image ? state.image.format : null,
      width: state.summary.width,
      height: state.summary.height,
      maxValue: state.summary.maxValue,
      threshold: state.summary.threshold,
    };
    if (kind === 'csv') return { text: exporter.toCsv(state.summary, meta), mime: 'text/csv' };
    return { text: exporter.toJson(state.summary, meta), mime: 'application/json' };
  }

  function exportAs(kind) {
    const payload = exportText(kind);
    if (!payload) return;
    const result = state.controller.getState().result;
    const base = 'regions-v' + (result ? result.jobVersion : 0);
    download(base + '.' + kind, payload.text, payload.mime);
    toast('已导出 ' + base + '.' + kind);
  }

  // --- fixtures ----------------------------------------------------------

  function buildFixtureButtons() {
    const list = fixtures.list();
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      const button = document.createElement('button');
      button.className = 'fixture' + (item.invalid ? ' invalid' : '');
      button.type = 'button';
      const title = document.createElement('b');
      title.textContent = item.title;
      const desc = document.createElement('span');
      desc.textContent = item.description;
      button.appendChild(title);
      button.appendChild(desc);
      if (item.expectError) {
        const tag = document.createElement('code');
        tag.textContent = item.expectError;
        button.appendChild(tag);
      }
      button.addEventListener('click', function () {
        const fixture = fixtures.get(item.id);
        loadBytes(fixture.bytes, {
          name: fixture.id + (fixture.format === 'rgba' ? '.rgba' : '.pgm'),
          format: fixture.format,
          width: fixture.width,
          height: fixture.height,
          limits: fixture.limits,
        });
      });
      el.fixtures.appendChild(button);
    }
  }

  // --- event wiring ------------------------------------------------------

  function handleFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const file = fileList[0];
    const lower = file.name.toLowerCase();
    const isRgba = lower.endsWith('.rgba') || lower.endsWith('.bin');
    const width = Number(el.rgbaWidth.value);
    const height = Number(el.rgbaHeight.value);
    const reader = new FileReader();
    reader.onload = function () {
      loadBytes(new Uint8Array(reader.result), {
        name: file.name,
        format: isRgba ? 'rgba' : 'pgm',
        width: isRgba ? width : undefined,
        height: isRgba ? height : undefined,
      });
    };
    reader.onerror = function () {
      showParseError({
        code: 'INVALID_INPUT',
        message: '无法读取文件。',
        userMessage: '无法读取文件。',
      });
    };
    reader.readAsArrayBuffer(file);
  }

  el.drop.addEventListener('click', function () {
    el.file.click();
  });
  el.drop.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      el.file.click();
    }
  });
  el.file.addEventListener('change', function () {
    handleFiles(el.file.files);
    el.file.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    el.drop.addEventListener(type, function (event) {
      event.preventDefault();
      el.drop.classList.add('hot');
    });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    el.drop.addEventListener(type, function () {
      el.drop.classList.remove('hot');
    });
  });
  el.drop.addEventListener('drop', function (event) {
    event.preventDefault();
    el.drop.classList.remove('hot');
    if (event.dataTransfer && event.dataTransfer.files) {
      handleFiles(event.dataTransfer.files);
    }
  });
  // Dropping anywhere on the page also works.
  window.addEventListener('dragover', function (event) {
    event.preventDefault();
  });
  window.addEventListener('drop', function (event) {
    event.preventDefault();
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      handleFiles(event.dataTransfer.files);
    }
  });

  el.threshold.addEventListener('input', function () {
    el.thresholdValue.textContent = Number(el.threshold.value).toFixed(2);
  });
  el.threshold.addEventListener('change', function () {
    if (state.image) startJob();
  });

  el.recompute.addEventListener('click', function () {
    startJob();
  });
  el.cancel.addEventListener('click', function () {
    if (state.controller) {
      state.controller.cancel();
    }
  });

  el.zoomIn.addEventListener('click', function () {
    if (!state.image) return;
    state.zoom = Math.min(
      state.zoom + 1,
      render.clampScale(state.image.width, state.image.height, 32)
    );
    drawSource();
  });
  el.zoomOut.addEventListener('click', function () {
    state.zoom = Math.max(1, state.zoom - 1);
    drawSource();
  });

  el.toggleOverlay.addEventListener('click', function () {
    state.overlayVisible = !state.overlayVisible;
    el.toggleOverlay.textContent = '叠加层：' + (state.overlayVisible ? '开' : '关');
    drawLabelOverlay();
  });

  el.exportCsv.addEventListener('click', function () {
    exportAs('csv');
  });
  el.exportJson.addEventListener('click', function () {
    exportAs('json');
  });

  window.addEventListener('resize', function () {
    if (!state.image) return;
    // Keep the integer zoom the user chose; only shrink if it no longer fits.
    const fit = computeFitScale(state.image.width, state.image.height);
    if (state.zoom > fit && state.zoom === state.fitScale) {
      state.zoom = fit;
      state.fitScale = fit;
      drawSource();
    }
  });

  // --- boot --------------------------------------------------------------

  buildFixtureButtons();
  renderStatusBar({
    jobVersion: 0,
    status: 'idle',
    phase: 'idle',
    hasResult: false,
    droppedMessages: 0,
  });
  updateImageInfo();
  el.thresholdValue.textContent = Number(el.threshold.value).toFixed(2);

  // Expose a minimal surface for the offline smoke test / debugging.
  window.workbench = {
    state: state,
    loadFixture: function (id) {
      const fixture = fixtures.get(id);
      if (!fixture) return false;
      return loadBytes(fixture.bytes, {
        name: fixture.id + (fixture.format === 'rgba' ? '.rgba' : '.pgm'),
        format: fixture.format,
        width: fixture.width,
        height: fixture.height,
      });
    },
    loadBytes: loadBytes,
    exportAs: exportAs,
    exportText: exportText,
  };
})();
