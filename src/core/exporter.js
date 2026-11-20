// Result export helpers. Everything here is pure so Node tests can compare
// the exported rows with the rows the UI renders — both come from the same
// `summary.regions` array, so "labels shown == labels exported" is structural.

(function (root, factory) {
  'use strict';
  const api = factory();
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.exporter = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CSV_COLUMNS = Object.freeze([
    'label',
    'x',
    'y',
    'width',
    'height',
    'area',
    'meanGray',
    'minGray',
    'maxGray',
    'transparentPixels',
  ]);

  function formatNumber(value, digits) {
    if (!Number.isFinite(value)) return '';
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(digits === undefined ? 3 : digits);
  }

  // Regions already arrive ordered by first appearance (label 1..N).
  function regionRows(summary) {
    const regions = (summary && summary.regions) || [];
    return regions.map(function (region) {
      return {
        label: region.label,
        x: region.bbox.x,
        y: region.bbox.y,
        width: region.bbox.width,
        height: region.bbox.height,
        area: region.area,
        meanGray: formatNumber(region.meanGray),
        minGray: region.minGray,
        maxGray: region.maxGray,
        transparentPixels: region.transparentPixels,
      };
    });
  }

  function csvEscape(value) {
    const text = String(value);
    if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function toCsv(summary, meta) {
    const rows = regionRows(summary);
    const lines = [];
    // A comment preamble is still valid CSV for our own re-import, and keeps
    // the file self-describing when opened in a plain editor. Missing meta
    // fields fall back to the summary so the header is never 0x0.
    const version = meta && meta.jobVersion != null ? meta.jobVersion : '';
    const width = meta && meta.width != null ? meta.width : summary.width;
    const height = meta && meta.height != null ? meta.height : summary.height;
    const maxValue = meta && meta.maxValue != null ? meta.maxValue : summary.maxValue;
    const threshold = meta && meta.threshold != null ? meta.threshold : summary.threshold;
    lines.push('# jobVersion=' + version);
    lines.push(
      '# image=' +
        width +
        'x' +
        height +
        ' maxValue=' +
        maxValue +
        ' threshold=' +
        threshold
    );
    lines.push(CSV_COLUMNS.join(','));
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      lines.push(CSV_COLUMNS.map(function (column) {
        return csvEscape(row[column]);
      }).join(','));
    }
    return lines.join('\n') + '\n';
  }

  function toJson(summary, meta) {
    const payload = {
      tool: 'image-annotation-workbench',
      schemaVersion: 1,
      provenance: {
        jobVersion: meta && meta.jobVersion != null ? meta.jobVersion : null,
        format: meta && meta.format ? meta.format : null,
        width: summary.width,
        height: summary.height,
        maxValue: summary.maxValue,
        bitsPerSample: summary.bitsPerSample,
        threshold: summary.threshold,
        cut: summary.cut,
      },
      stats: {
        foreground: summary.foreground,
        regionCount: summary.regionCount,
        grayRange: summary.grayRange,
        alphaRange: summary.alphaRange,
      },
      columns: CSV_COLUMNS.slice(),
      regions: (summary.regions || []).map(function (region) {
        return {
          label: region.label,
          bbox: {
            x: region.bbox.x,
            y: region.bbox.y,
            width: region.bbox.width,
            height: region.bbox.height,
          },
          area: region.area,
          meanGray: Number(formatNumber(region.meanGray)),
          minGray: region.minGray,
          maxGray: region.maxGray,
          transparentPixels: region.transparentPixels,
        };
      }),
    };
    return JSON.stringify(payload, null, 2) + '\n';
  }

  return {
    CSV_COLUMNS,
    regionRows,
    toCsv,
    toJson,
    csvEscape,
    formatNumber,
  };
});
