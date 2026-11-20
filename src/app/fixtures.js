// Deterministic, code-generated boundary fixtures. Both the demo page's
// "载入边界样本" buttons and the offline tests call these builders, so the
// samples in the UI and the samples in the tests are byte-for-byte the same
// and nothing is loaded from the network or from a pre-generated file.

(function (root, factory) {
  'use strict';
  const api = factory();
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.fixtures = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ASCII_P = 0x50;
  const ASCII_5 = 0x35;

  function asciiBytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function concat(parts) {
    let total = 0;
    for (let i = 0; i < parts.length; i += 1) total += parts[i].length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < parts.length; i += 1) {
      out.set(parts[i], offset);
      offset += parts[i].length;
    }
    return out;
  }

  // Builds a P5 file from parts so callers can control exact header bytes,
  // comments and the single whitespace byte that ends the header.
  function buildPgm(options) {
    const magic = asciiBytes('P5');
    const sep = options.separator === undefined ? '\n' : options.separator;
    const parts = [magic, asciiBytes(sep)];
    if (options.commentAfterMagic) {
      parts.push(asciiBytes('#' + options.commentAfterMagic + '\n'));
    }
    parts.push(asciiBytes(String(options.width)));
    parts.push(asciiBytes(options.between === undefined ? ' ' : options.between));
    if (options.commentAfterWidth) {
      parts.push(asciiBytes('#' + options.commentAfterWidth + '\n'));
    }
    parts.push(asciiBytes(String(options.height)));
    parts.push(asciiBytes(options.between2 === undefined ? '\n' : options.between2));
    parts.push(asciiBytes(String(options.maxValue)));
    // Comments are only legal *between* header tokens, so there is no
    // commentAfterMax option: the byte right after maxval is the single
    // header terminator, and everything after it is raster data.
    parts.push(asciiBytes(options.terminator === undefined ? '\n' : options.terminator));
    const raster = encodeRaster(options);
    parts.push(raster);
    return concat(parts);
  }

  function encodeRaster(options) {
    const samples = options.samples;
    if (options.maxValue < 256) {
      const out = new Uint8Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] & 0xff;
      return out;
    }
    const out = new Uint8Array(samples.length * 2);
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i] & 0xffff;
      out[i * 2] = (value >> 8) & 0xff; // big-endian, high byte first
      out[i * 2 + 1] = value & 0xff;
    }
    return out;
  }

  function filled(width, height, value) {
    const samples = new Uint16Array(width * height);
    samples.fill(value);
    return samples;
  }

  function withPeaks(width, height, base, peaks) {
    const samples = filled(width, height, base);
    for (let i = 0; i < peaks.length; i += 1) {
      const peak = peaks[i];
      samples[peak.y * width + peak.x] = peak.value;
    }
    return samples;
  }

  // --- Named samples -------------------------------------------------------

  // 16x16 uniform mid-gray: local contrast is 0 everywhere => no regions.
  function flatPgm() {
    const width = 16;
    const height = 16;
    const samples = filled(width, height, 100);
    return {
      id: 'pgm-flat',
      title: '平坦区（无区域）',
      description: '16×16 全为 100，局部对比度为 0，应得到 0 个区域。',
      format: 'pgm',
      width: width,
      height: height,
      maxValue: 255,
      bytes: buildPgm({ width: width, height: height, maxValue: 255, samples: samples }),
    };
  }

  // 7x7 zeros with a single bright center: exactly one 3x3 region.
  function isolatedPeakPgm() {
    const width = 7;
    const height = 7;
    const samples = withPeaks(width, height, 0, [{ x: 3, y: 3, value: 255 }]);
    return {
      id: 'pgm-peak',
      title: '孤立亮峰',
      description: '7×7 全 0，中心 255：局部对比度只在 3×3 邻域内非 0，应得到 1 个 3×3 区域。',
      format: 'pgm',
      width: width,
      height: height,
      maxValue: 255,
      bytes: buildPgm({ width: width, height: height, maxValue: 255, samples: samples }),
    };
  }

  // Header trivia: comments between tokens, CRLF, and a raster whose first
  // two bytes are 0x20 (space) and 0x23 ('#') — both must stay pixels.
  function headerQuirkPgm() {
    const width = 3;
    const height = 3;
    const samples = new Uint16Array([0x20, 0x23, 1, 2, 3, 4, 5, 6, 7]);
    return {
      id: 'pgm-header-quirk',
      title: '注释/空白与像素起点',
      description:
        '文件头含 # 注释与 CRLF；3×3 像素数据首字节为 0x20（空格）和 0x23（#），必须按像素解析。',
      format: 'pgm',
      width: width,
      height: height,
      maxValue: 255,
      bytes: buildPgm({
        width: width,
        height: height,
        maxValue: 255,
        samples: samples,
        commentAfterMagic: ' header comment',
        commentAfterWidth: ' between tokens',
        between: '  ',
        separator: '\r\n',
        terminator: '\r\n',
      }),
      expectedFirstSamples: [0x20, 0x23, 1],
    };
  }

  // 8x8, 16-bit big-endian samples with maxval 65535 and a high-value 2x2
  // block. Raw samples must survive: gray max == 65000, never rescaled.
  function high16Pgm() {
    const width = 8;
    const height = 8;
    const samples = filled(width, height, 0);
    for (let y = 3; y <= 4; y += 1) {
      for (let x = 3; x <= 4; x += 1) samples[y * width + x] = 65000;
    }
    samples[0] = 0x1234; // 4660 — checks big-endian byte order
    return {
      id: 'pgm-16-high',
      title: '十六位高值（大端）',
      description:
        '8×8、maxval 65535、中心 2×2 为 65000；灰度峰值必须保持 65000，不得缩放到 255。角落样本字节 0x12 0x34 应解为 4660。',
      format: 'pgm',
      width: width,
      height: height,
      maxValue: 65535,
      bytes: buildPgm({ width: width, height: height, maxValue: 65535, samples: samples }),
      probeSample: { index: 0, value: 0x1234 },
    };
  }

  // 8x8 16-bit values with maxval 300 (still big-endian 16-bit) to prove the
  // 8/16-bit switch is driven by maxValue, not by byte count alone.
  function maxval300Pgm() {
    const width = 4;
    const height = 4;
    const samples = filled(width, height, 300);
    samples[0] = 0x012c;
    return {
      id: 'pgm-maxval-300',
      title: 'maxval 300（仍是 16 位）',
      description: 'maxval 300 属于 16 位样本，4×4 全 300，验证样本宽度选择。',
      format: 'pgm',
      width: width,
      height: height,
      maxValue: 300,
      bytes: buildPgm({ width: width, height: height, maxValue: 300, samples: samples }),
    };
  }

  function makeRgba(width, height, fill, edits) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      data[i * 4] = fill[0];
      data[i * 4 + 1] = fill[1];
      data[i * 4 + 2] = fill[2];
      data[i * 4 + 3] = fill[3];
    }
    for (let e = 0; e < edits.length; e += 1) {
      const edit = edits[e];
      const o = (edit.y * width + edit.x) * 4;
      data[o] = edit.rgba[0];
      data[o + 1] = edit.rgba[1];
      data[o + 2] = edit.rgba[2];
      data[o + 3] = edit.rgba[3];
    }
    return data;
  }

  // Two isolated white peaks: one fully transparent (must be excluded), one
  // opaque (must form a 3x3 region).
  function rgbaTransparent() {
    const width = 6;
    const height = 6;
    const data = makeRgba(width, height, [100, 100, 100, 255], [
      { x: 1, y: 1, rgba: [255, 255, 255, 255] },
      { x: 4, y: 4, rgba: [255, 255, 255, 0] },
    ]);
    return {
      id: 'rgba-transparent',
      title: 'RGBA 透明像素',
      description:
        '6×6 不透明中灰，两个白色亮峰：一个 alpha=0（必须排除），一个 alpha=255（应形成 3×3 区域）。',
      format: 'rgba',
      width: width,
      height: height,
      maxValue: 255,
      bytes: data,
      expected: { opaquePeak: { x: 1, y: 1 }, transparentPeak: { x: 4, y: 4 } },
    };
  }

  // Semi-transparent peak (alpha 128) must still count, and report meanAlpha.
  function rgbaSemi() {
    const width = 6;
    const height = 6;
    const data = makeRgba(width, height, [100, 100, 100, 255], [
      { x: 1, y: 1, rgba: [255, 255, 255, 128] },
    ]);
    return {
      id: 'rgba-semi',
      title: 'RGBA 半透明亮峰',
      description: '6×6，单个 alpha=128 白色亮峰：半透明像素仍参与标记，区域 meanAlpha 应为 128。',
      format: 'rgba',
      width: width,
      height: height,
      maxValue: 255,
      bytes: data,
      expected: { meanAlpha: 128 },
    };
  }

  // A two-pixel diagonal pattern used to prove 4-connectivity (built as PGMs
  // so the whole browser path can be exercised, and also exposed as a mask
  // helper for the labeling unit test).
  function twoPeaksPgm() {
    const width = 9;
    const height = 9;
    const samples = filled(width, height, 0);
    // Two bright pixels separated by a blank column so their 3x3 contrast
    // windows are disjoint: exactly two regions, labels 1 then 2 in raster
    // order. Diagonal 4-connectivity itself is covered by labelRegions tests.
    samples[2 * width + 2] = 255;
    samples[6 * width + 6] = 255;
    return {
      id: 'pgm-two-peaks',
      title: '两个独立区域',
      description:
        '9×9 中两枚分离的亮像素，各产生一个 3×3 区域，标签按光栅顺序为 1、2。',
      format: 'pgm',
      width: width,
      height: height,
      maxValue: 255,
      bytes: buildPgm({ width: width, height: height, maxValue: 255, samples: samples }),
    };
  }

  // --- Invalid samples used to demonstrate the unified error taxonomy -----

  function truncatedRaster() {
    const full = isolatedPeakPgm();
    return {
      id: 'bad-truncated-raster',
      title: '截断像素数据（应报错）',
      description: '孤立亮峰样本去掉最后一个像素字节：应在分配后校验时报 TRUNCATED_RASTER。',
      format: 'pgm',
      width: full.width,
      height: full.height,
      maxValue: 255,
      bytes: full.bytes.subarray(0, full.bytes.length - 1),
      expectError: 'TRUNCATED_RASTER',
      invalid: true,
    };
  }

  function trailingData() {
    const full = isolatedPeakPgm();
    return {
      id: 'bad-trailing-data',
      title: '多余尾随字节（应报错）',
      description: '孤立亮峰样本后追加 3 个字节：应报 TRAILING_DATA，而不是静默忽略。',
      format: 'pgm',
      width: full.width,
      height: full.height,
      maxValue: 255,
      bytes: concat([full.bytes, new Uint8Array([0, 0, 0])]),
      expectError: 'TRAILING_DATA',
      invalid: true,
    };
  }

  function budgetRefusal() {
    const full = isolatedPeakPgm();
    return {
      id: 'bad-budget',
      title: '超过文件预算（应报错）',
      description: '同一份合法样本，用 8 字节的文件预算解析：应在解析前报 FILE_BUDGET_EXCEEDED。',
      format: 'pgm',
      width: full.width,
      height: full.height,
      maxValue: 255,
      bytes: full.bytes,
      limits: { maxFileBytes: 8 },
      expectError: 'FILE_BUDGET_EXCEEDED',
      invalid: true,
    };
  }

  function dimensionOverflow() {
    return {
      id: 'bad-dimension-overflow',
      title: '尺寸溢出（应报错）',
      description: '文件头声明 1e15 × 1e15：应在分配像素数组之前报 DIMENSION_OVERFLOW。',
      format: 'pgm',
      width: 0,
      height: 0,
      maxValue: 255,
      bytes: asciiBytes('P5\n999999999999999 999999999999999\n255\n'),
      expectError: 'DIMENSION_OVERFLOW',
      invalid: true,
    };
  }

  const BUILDERS = [
    flatPgm,
    isolatedPeakPgm,
    headerQuirkPgm,
    high16Pgm,
    maxval300Pgm,
    rgbaTransparent,
    rgbaSemi,
    twoPeaksPgm,
    truncatedRaster,
    trailingData,
    budgetRefusal,
    dimensionOverflow,
  ];

  function list() {
    return BUILDERS.map(function (build) {
      const fixture = build();
      return {
        id: fixture.id,
        title: fixture.title,
        description: fixture.description,
        format: fixture.format,
        width: fixture.width,
        height: fixture.height,
        maxValue: fixture.maxValue,
        byteLength: fixture.bytes.length,
        invalid: Boolean(fixture.invalid),
        expectError: fixture.expectError || null,
        limits: fixture.limits || null,
        build: build,
      };
    });
  }

  function get(id) {
    for (let i = 0; i < BUILDERS.length; i += 1) {
      const fixture = BUILDERS[i]();
      if (fixture.id === id) return fixture;
    }
    return null;
  }

  return {
    asciiBytes,
    concat,
    buildPgm,
    encodeRaster,
    flatPgm,
    isolatedPeakPgm,
    headerQuirkPgm,
    high16Pgm,
    maxval300Pgm,
    rgbaTransparent,
    rgbaSemi,
    twoPeaksPgm,
    truncatedRaster,
    trailingData,
    budgetRefusal,
    dimensionOverflow,
    list,
    get,
  };
});
