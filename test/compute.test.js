'use strict';

const test = require('node:test');
const { assert, core, runJobInProcess } = require('./harness.js');

const { parser, compute, fixtures } = core;

function regionSignature(summary) {
  return summary.regions.map((region) => ({
    label: region.label,
    area: region.area,
    bbox: region.bbox,
    minGray: region.minGray,
    maxGray: region.maxGray,
  }));
}

test('flat region produces zero areas and no regions', async () => {
  const fixture = fixtures.flatPgm();
  const image = parser.parsePgm(fixture.bytes);
  const result = await compute.runPipeline(image, { threshold: 0.15 });
  assert.equal(result.summary.regionCount, 0);
  assert.equal(result.summary.foreground, 0);
  assert.deepEqual(Array.from(result.contrast), new Array(256).fill(0));
  assert.deepEqual(result.summary.grayRange, { min: 100, max: 100 });
});

test('an isolated bright peak yields exactly one 3x3 region at its location', async () => {
  const fixture = fixtures.isolatedPeakPgm();
  const image = parser.parsePgm(fixture.bytes);
  const result = await compute.runPipeline(image, { threshold: 0.15 });
  assert.equal(result.summary.regionCount, 1);
  const region = result.summary.regions[0];
  assert.equal(region.label, 1);
  assert.equal(region.area, 9, 'the 3x3 window around the peak is the whole mask');
  assert.deepEqual(region.bbox, { x: 2, y: 2, width: 3, height: 3 });
  assert.equal(region.maxGray, 255);
  assert.equal(region.minGray, 0);
});

test('4-connectivity merges diagonal mask pixels only through shared edges', () => {
  // A checkerboard mask: no two 1s share an edge, so with 4-connectivity every
  // foreground pixel is its own region. An 8-connected implementation would
  // collapse all of them into one region.
  const width = 6;
  const height = 6;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) mask[y * width + x] = (x + y) % 2;
  }
  const checker = compute.labelRegions(mask, width, height);
  assert.equal(checker.regions.length, 18, '18 isolated pixels => 18 regions');
  assert.ok(checker.regions.every((r) => r.area === 1));

  // Two blocks touching only at a corner must stay separate.
  const cornerMask = new Uint8Array([
    1, 0, 0,
    0, 1, 0,
    0, 0, 0,
  ]);
  const corner = compute.labelRegions(cornerMask, 3, 3);
  assert.equal(corner.regions.length, 2);
  assert.deepEqual(Array.from(corner.labels), [1, 0, 0, 0, 2, 0, 0, 0, 0]);
});

test('two separated peaks yield two regions labelled in raster order', async () => {
  const fixture = fixtures.twoPeaksPgm();
  const image = parser.parsePgm(fixture.bytes);
  const result = await compute.runPipeline(image, { threshold: 0.15 });
  assert.equal(result.summary.regionCount, 2);
  assert.deepEqual(result.summary.regions.map((r) => r.label), [1, 2]);
  assert.deepEqual(result.summary.regions.map((r) => r.area), [9, 9]);
  // First appearance in raster order: the upper-left peak gets label 1.
  assert.ok(result.summary.regions[0].bbox.y < result.summary.regions[1].bbox.y);
});

test('16-bit high values survive as raw intensities, not rescaled', async () => {
  const fixture = fixtures.high16Pgm();
  const image = parser.parsePgm(fixture.bytes);
  const result = await compute.runPipeline(image, { threshold: 0.15 });
  assert.equal(result.summary.maxValue, 65535);
  assert.equal(result.summary.grayRange.max, 65000);
  assert.ok(result.summary.regions.length >= 1);
  // A naive 8-bit rescale would cap the max at 255.
  assert.notEqual(result.summary.grayRange.max, 255);
  const maxRegion = result.summary.regions.reduce((best, region) =>
    region.maxGray > best.maxGray ? region : best
  );
  assert.equal(maxRegion.maxGray, 65000);
});

test('threshold is relative to maxval and rejects out-of-range values', async () => {
  const fixture = fixtures.high16Pgm();
  const image = parser.parsePgm(fixture.bytes);
  const low = await compute.runPipeline(image, { threshold: 0.9 });
  const high = await compute.runPipeline(image, { threshold: 0.99 });
  assert.ok(low.summary.cut < high.summary.cut);
  assert.equal(low.summary.cut, 0.9 * 65535);
  await assert.rejects(
    () => compute.runPipeline(image, { threshold: 1.5 }),
    (error) => error.code === 'INVALID_INPUT'
  );
});

test('fully transparent pixels are never labelled, opaque neighbours may be', async () => {
  const fixture = fixtures.rgbaTransparent();
  const image = parser.parseRgbaRaw(fixture.bytes, {
    width: fixture.width,
    height: fixture.height,
  });
  const result = await compute.runPipeline(image, { threshold: 0.15 });

  // Core invariant: a pixel whose alpha is 0 has label 0 and is never part of
  // any region's area, regardless of its intensity.
  const peakIndex = fixture.expected.transparentPeak.y * image.width + fixture.expected.transparentPeak.x;
  assert.equal(image.alpha[peakIndex], 0);
  assert.equal(result.labels[peakIndex], 0, 'transparent peak must not be labelled');
  for (let i = 0; i < image.pixelCount; i += 1) {
    if (image.alpha[i] === 0) assert.equal(result.labels[i], 0);
  }
  assert.equal(result.summary.alphaRange.min, 0);
  // Region areas count only labelled pixels, none of which are transparent.
  const labelledTotal = result.summary.regions.reduce((sum, r) => sum + r.area, 0);
  let nonTransparentLabelled = 0;
  for (let i = 0; i < image.pixelCount; i += 1) {
    if (result.labels[i]) nonTransparentLabelled += 1;
  }
  assert.equal(labelledTotal, nonTransparentLabelled);

  // The opaque peak is inside some region.
  const opaqueIndex = fixture.expected.opaquePeak.y * image.width + fixture.expected.opaquePeak.x;
  assert.ok(result.labels[opaqueIndex] > 0, 'opaque peak must be labelled');
  // Every region reported by the summary reports transparentPixels === 0.
  for (const region of result.summary.regions) {
    assert.equal(region.transparentPixels, 0);
  }
});

test('semi-transparent peaks still count and report a mixed meanAlpha', async () => {
  const fixture = fixtures.rgbaSemi();
  const image = parser.parseRgbaRaw(fixture.bytes, {
    width: fixture.width,
    height: fixture.height,
  });
  const result = await compute.runPipeline(image, { threshold: 0.15 });
  assert.equal(result.summary.regionCount, 1);
  const region = result.summary.regions[0];
  assert.equal(region.transparentPixels, 0);
  const peakIndex = fixture.expected.opaquePeak
    ? fixture.expected.opaquePeak.y * image.width + fixture.expected.opaquePeak.x
    : 0;
  assert.ok(result.labels[1 * image.width + 1] > 0, 'semi-transparent peak is labelled');
  void peakIndex;
  // The region is the 3x3 neighbourhood: 8 opaque (255) + 1 at alpha 128.
  assert.equal(region.meanAlpha, (8 * 255 + 128) / 9);
  assert.ok(region.meanAlpha > 128 && region.meanAlpha < 255);
});

test('labels, areas and bounding boxes are deterministic across runs', async () => {
  const fixture = fixtures.headerQuirkPgm();
  const image = parser.parsePgm(fixture.bytes);
  const first = await compute.runPipeline(image, { threshold: 0.1 });
  const second = await compute.runPipeline(image, { threshold: 0.1 });
  assert.deepEqual(Array.from(first.labels), Array.from(second.labels));
  assert.deepEqual(regionSignature(first.summary), regionSignature(second.summary));
});

test('the pipeline never mutates the source image', async () => {
  const fixture = fixtures.high16Pgm();
  const image = parser.parsePgm(fixture.bytes);
  const before = Array.from(image.samples);
  await compute.runPipeline(image, { threshold: 0.15 });
  assert.deepEqual(Array.from(image.samples), before);
});

test('labeling is independent of the displayed scale (pure raster operation)', () => {
  // Build a mask directly; labels must depend only on mask geometry.
  const width = 4;
  const height = 4;
  const mask = new Uint8Array([
    1, 0, 0, 1,
    1, 0, 0, 1,
    0, 1, 1, 0,
    0, 1, 1, 0,
  ]);
  const a = compute.labelRegions(mask, width, height);
  const b = compute.labelRegions(mask, width, height);
  assert.deepEqual(Array.from(a.labels), Array.from(b.labels));
  // Two diagonal 1x2 blocks plus a 2x2 block => 3 regions.
  assert.equal(a.regions.length, 3);
  const areas = a.regions.map((r) => r.area);
  assert.deepEqual(areas, [2, 2, 4]);
});

test('cancellation throws PIPELINE_CANCELLED and no done/labeling is emitted', async () => {
  const fixture = fixtures.high16Pgm();
  const image = parser.parsePgm(fixture.bytes);
  const { messages } = await runJobInProcess(image, { threshold: 0.15 }, {
    // Cancel after the first stage message so mid-pipeline polling triggers.
    cancelAfter: (count) => count >= 1,
  });
  const types = messages.map((entry) => entry.message.type);
  assert.ok(types.includes('cancelled'), 'expected a cancelled message');
  assert.ok(!types.includes('done'), 'a cancelled job must not publish');
  const labeling = messages.filter(
    (entry) => entry.message.type === 'stage' && entry.message.stage === 'labeling'
  );
  assert.equal(labeling.length, 0);
});

test('stage messages arrive in pipeline order', async () => {
  const fixture = fixtures.isolatedPeakPgm();
  const image = parser.parsePgm(fixture.bytes);
  const { stages } = await runJobInProcess(image, { threshold: 0.15 });
  assert.deepEqual(stages, ['grayscale', 'contrast', 'threshold', 'labeling']);
});

test('cancelling after any stage never emits labeling or done', async () => {
  const fixture = fixtures.high16Pgm();
  const image = parser.parsePgm(fixture.bytes);
  // Try cancelling at every possible message boundary: the pipeline must be
  // safe at all of them — no partial result is ever published.
  for (let boundary = 1; boundary <= 3; boundary += 1) {
    const { messages } = await runJobInProcess(image, { threshold: 0.15 }, {
      cancelAfter: (count) => count >= boundary,
    });
    const types = messages.map((entry) => entry.message.type);
    assert.ok(types.includes('cancelled'), 'boundary ' + boundary + ' should cancel');
    assert.equal(types.includes('done'), false, 'boundary ' + boundary + ' must not publish');
    assert.equal(
      messages.some((e) => e.message.type === 'stage' && e.message.stage === 'labeling'),
      false
    );
  }
});

test('a cancelled run resolves to null and leaves no error message', async () => {
  const fixture = fixtures.isolatedPeakPgm();
  const image = parser.parsePgm(fixture.bytes);
  const { result, messages } = await runJobInProcess(image, {}, {
    cancelAfter: () => true,
  });
  assert.equal(result, null);
  assert.equal(messages.some((e) => e.message.type === 'error'), false);
});

test('overlay colors are a pure function of the label', () => {
  assert.deepEqual(compute.colorForLabel(0), [0, 0, 0, 0]);
  const first = compute.colorForLabel(1);
  const again = compute.colorForLabel(1);
  assert.deepEqual(first, again);
  assert.notDeepEqual(compute.colorForLabel(1), compute.colorForLabel(2));
});
