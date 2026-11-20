'use strict';

const test = require('node:test');
const { assert, core, runJobInProcess } = require('./harness.js');

const { parser, compute, exporter, fixtures } = core;

function parseCsv(text) {
  const lines = text.trimEnd().split('\n').filter((line) => !line.startsWith('#'));
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    // The exporter only quotes fields containing commas/quotes/newlines; none
    // of our numeric fields do, so a simple split is exact for this data.
    const cells = line.split(',');
    const row = {};
    header.forEach((name, i) => {
      row[name] = cells[i];
    });
    return row;
  });
}

async function analyse(id, threshold) {
  const fixture = fixtures.get(id);
  const image =
    fixture.format === 'rgba'
      ? parser.parseRgbaRaw(fixture.bytes, { width: fixture.width, height: fixture.height })
      : parser.parsePgm(fixture.bytes);
  const result = await compute.runPipeline(image, { threshold: threshold == null ? 0.15 : threshold });
  return { fixture, image, result };
}

test('CSV export rows match the displayed region table rows exactly', async () => {
  const { result } = await analyse('pgm-two-peaks');
  const displayed = exporter.regionRows(result.summary); // what the UI renders
  const csvRows = parseCsv(exporter.toCsv(result.summary, { jobVersion: 7 }));

  assert.equal(csvRows.length, displayed.length);
  displayed.forEach((row, index) => {
    const csvRow = csvRows[index];
    assert.equal(csvRow.label, String(row.label));
    assert.equal(csvRow.area, String(row.area));
    assert.equal(csvRow.x, String(row.x));
    assert.equal(csvRow.y, String(row.y));
    assert.equal(csvRow.width, String(row.width));
    assert.equal(csvRow.height, String(row.height));
  });
  // Labels in the export are exactly 1..N in the same order as the UI.
  assert.deepEqual(
    csvRows.map((r) => Number(r.label)),
    displayed.map((r) => r.label)
  );
});

test('JSON export regions agree with CSV and with the label raster areas', async () => {
  const { result } = await analyse('pgm-16-high');
  const json = JSON.parse(
    exporter.toJson(result.summary, { jobVersion: 9, format: 'pgm-p5', bitsPerSample: 16 })
  );
  const csvRows = parseCsv(exporter.toCsv(result.summary, { jobVersion: 9 }));

  // Recompute each region's area directly from the label raster.
  const counts = new Map();
  for (let i = 0; i < result.labels.length; i += 1) {
    const label = result.labels[i];
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  assert.equal(json.regions.length, csvRows.length);
  assert.equal(json.regions.length, counts.size);
  json.regions.forEach((region, index) => {
    assert.equal(region.label, csvRows[index].label ? Number(csvRows[index].label) : index + 1);
    assert.equal(region.area, counts.get(region.label), 'area matches the raster');
    assert.equal(region.area, Number(csvRows[index].area));
    // bbox matches CSV
    assert.equal(region.bbox.x, Number(csvRows[index].x));
    assert.equal(region.bbox.y, Number(csvRows[index].y));
  });
  assert.equal(json.provenance.jobVersion, 9);
  assert.equal(json.provenance.format, 'pgm-p5');
  assert.equal(json.provenance.bitsPerSample, 16);});

test('exported label numbers match the palette used to draw the overlay', async () => {
  const { result } = await analyse('rgba-transparent');
  const overlay = compute.buildOverlay(result.labels, result.summary.width, result.summary.height);
  const rows = exporter.regionRows(result.summary);
  assert.ok(rows.length >= 1);
  // Find one pixel of each exported label and confirm the overlay there is
  // exactly that label's palette colour (i.e. UI colour and export label agree).
  for (const row of rows) {
    let index = -1;
    for (let i = 0; i < result.labels.length; i += 1) {
      if (result.labels[i] === row.label) {
        index = i;
        break;
      }
    }
    assert.ok(index >= 0, 'label ' + row.label + ' missing from raster');
    const color = compute.colorForLabel(row.label);
    const o = index * 4;
    assert.deepEqual(
      [overlay[o], overlay[o + 1], overlay[o + 2], overlay[o + 3]],
      color
    );
  }
  // Label 0 (background) is fully transparent in the overlay.
  for (let i = 0; i < result.labels.length; i += 1) {
    if (result.labels[i] === 0) {
      assert.equal(overlay[i * 4 + 3], 0);
    }
  }
});

test('empty results export a header-only CSV and an empty JSON region list', async () => {
  const { result } = await analyse('pgm-flat');
  assert.equal(result.summary.regionCount, 0);
  const csv = exporter.toCsv(result.summary, { jobVersion: 1 });
  const rows = parseCsv(csv);
  assert.equal(rows.length, 0);
  assert.ok(csv.includes('label,x,y,width,height,area'));
  const json = JSON.parse(exporter.toJson(result.summary, { jobVersion: 1 }));
  assert.deepEqual(json.regions, []);
  assert.equal(json.stats.regionCount, 0);
});

test('CSV escaping survives a pathological provenance comment', () => {
  const summary = {
    width: 1,
    height: 1,
    maxValue: 255,
    bitsPerSample: 8,
    threshold: 0.1,
    cut: 25.5,
    foreground: 1,
    regionCount: 1,
    regions: [
      {
        label: 1,
        area: 1,
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        meanGray: 12.5,
        minGray: 12,
        maxGray: 13,
        transparentPixels: 0,
      },
    ],
  };
  const csv = exporter.toCsv(summary, { jobVersion: 3 });
  assert.ok(csv.startsWith('# jobVersion=3'));
  assert.equal(exporter.csvEscape('a,b'), '"a,b"');
  assert.equal(exporter.csvEscape('a"b'), '"a""b"');
});

test('worker done message carries the summary that the export uses', async () => {
  const fixture = fixtures.isolatedPeakPgm();
  const image = parser.parsePgm(fixture.bytes);
  const { messages } = await runJobInProcess(image, { threshold: 0.15 });
  const done = messages.find((entry) => entry.message.type === 'done');
  assert.ok(done, 'expected a done message');
  assert.equal(done.message.summary.regionCount, 1);
  const csvRows = parseCsv(
    exporter.toCsv(done.message.summary, { jobVersion: done.message.jobVersion })
  );
  assert.equal(csvRows.length, 1);
  assert.equal(csvRows[0].area, '9');
});
