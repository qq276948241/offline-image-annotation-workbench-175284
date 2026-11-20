'use strict';

const test = require('node:test');
const { assert, core } = require('./harness.js');

const { parser, fixtures, errors, limits } = core;
const { ImageFormatError } = errors;

function expectCode(bytes, code, options) {
  let caught = null;
  try {
    if (options && options.rgba) {
      parser.parseRgbaRaw(bytes, options);
    } else {
      parser.parsePgm(bytes, options || {});
    }
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected an error for code ' + code);
  assert.ok(caught instanceof ImageFormatError, 'error must be ImageFormatError');
  assert.equal(caught.code, code, 'unexpected code: ' + caught.code + ' (' + caught.message + ')');
  return caught;
}

test('parses a well-formed 8-bit P5 and separates comments, whitespace and pixel start', () => {
  const fixture = fixtures.headerQuirkPgm();
  const image = parser.parsePgm(fixture.bytes);
  assert.equal(image.kind, 'pgm');
  assert.equal(image.format, 'pgm-p5');
  assert.equal(image.width, 3);
  assert.equal(image.height, 3);
  assert.equal(image.maxValue, 255);
  assert.equal(image.bitsPerSample, 8);
  assert.equal(image.pixelCount, 9);
  // The raster really begins with 0x20 and 0x23; they must be pixel values,
  // not a comment or a separator.
  assert.deepEqual(Array.from(image.samples), [0x20, 0x23, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(fixture.expectedFirstSamples, [0x20, 0x23, 1]);
  // pixelStart is the byte immediately after the header's single terminator.
  assert.equal(image.headerBytes, image.pixelStart);
  assert.equal(image.bytesPerSample, 1);
});

test('comments are accepted between every header token', () => {
  const bytes = fixtures.buildPgm({
    width: 2,
    height: 1,
    maxValue: 255,
    samples: new Uint16Array([1, 2]),
    commentAfterMagic: ' magic',
    commentAfterWidth: ' between w/h',
    separator: '\n',
    between: '\n',
    between2: '  ',
    terminator: ' ',
  });
  const image = parser.parsePgm(bytes);
  assert.deepEqual(Array.from(image.samples), [1, 2]);
});

test('a # immediately after maxval is rejected, not silently swallowed', () => {
  const bytes = fixtures.asciiBytes('P5\n2 1\n255# trailing\n') ;
  // Build the exact bytes: header then '#...' then raster.
  const combined = fixtures.concat([
    fixtures.asciiBytes('P5\n2 1\n255'),
    fixtures.asciiBytes('# not a comment here\n'),
    new Uint8Array([1, 2]),
  ]);
  const error = expectCode(combined, 'BAD_HEADER');
  assert.equal(error.details.byte, 0x23);
  void bytes;
});

test('CRLF header terminator consumes exactly one CRLF, not two bytes of pixels', () => {
  const bytes = fixtures.buildPgm({
    width: 2,
    height: 1,
    maxValue: 255,
    samples: new Uint16Array([9, 10]),
    separator: '\r\n',
    between: '\r\n',
    between2: '\r\n',
    terminator: '\r\n',
  });
  const image = parser.parsePgm(bytes);
  assert.deepEqual(Array.from(image.samples), [9, 10]);
});

test('16-bit big-endian samples are preserved verbatim (no rescale to 8-bit)', () => {
  const fixture = fixtures.high16Pgm();
  const image = parser.parsePgm(fixture.bytes);
  assert.equal(image.bitsPerSample, 16);
  assert.equal(image.bytesPerSample, 2);
  assert.equal(image.maxValue, 65535);
  assert.equal(image.samples[0], 0x1234, 'big-endian high byte first');
  assert.equal(image.samples[3 * 8 + 3], 65000);
  assert.equal(image.samples[0], fixture.probeSample.value);
  // The stored array is a Uint16Array of raw sample values.
  assert.ok(image.samples instanceof Uint16Array);
  assert.equal(image.samples.length, 64);
});

test('sample width follows maxval, not guesswork: maxval 300 is 16-bit', () => {
  const fixture = fixtures.maxval300Pgm();
  const image = parser.parsePgm(fixture.bytes);
  assert.equal(image.bitsPerSample, 16);
  assert.equal(image.maxValue, 300);
  assert.equal(image.samples[0], 300);
  assert.equal(image.samples[1], 300);
});

test('maxval 256 is the 16-bit boundary', () => {
  const eight = fixtures.buildPgm({
    width: 1,
    height: 1,
    maxValue: 255,
    samples: new Uint16Array([255]),
  });
  const sixteen = fixtures.buildPgm({
    width: 1,
    height: 1,
    maxValue: 256,
    samples: new Uint16Array([256]),
  });
  assert.equal(parser.parsePgm(eight).bitsPerSample, 8);
  const image = parser.parsePgm(sixteen);
  assert.equal(image.bitsPerSample, 16);
  assert.equal(image.samples[0], 256);
});

test('raw RGBA preserves alpha and rejects off-by-one dimensions', () => {
  const fixture = fixtures.rgbaTransparent();
  const image = parser.parseRgbaRaw(fixture.bytes, {
    width: fixture.width,
    height: fixture.height,
  });
  assert.equal(image.kind, 'rgba');
  assert.equal(image.channels, 4);
  assert.equal(image.pixelCount, 36);
  assert.equal(image.alpha[1 * 6 + 1], 255);
  assert.equal(image.alpha[4 * 6 + 4], 0);
  // RGBA bytes round-trip exactly.
  assert.deepEqual(
    Array.from(image.rgba.subarray(0, 4)),
    Array.from(fixture.bytes.subarray(0, 4))
  );
});

test('parseImage routes PGM from magic and RGBA from declared dimensions', () => {
  const pgm = fixtures.flatPgm();
  assert.equal(parser.parseImage(pgm.bytes).kind, 'pgm');
  const rgba = fixtures.rgbaSemi();
  assert.equal(
    parser.parseImage(rgba.bytes, { kind: 'rgba', width: rgba.width, height: rgba.height }).kind,
    'rgba'
  );
  assert.equal(parser.sniffFormat(pgm.bytes), 'pgm');
  assert.equal(parser.sniffFormat(new Uint8Array([1, 2, 3])), null);
});

test('an explicit RGBA declaration wins over a P5-looking first pixel', () => {
  // A raw RGBA buffer is arbitrary bytes; R=0x50, G=0x35 is a legal pixel but
  // also spells "P5". The declared kind must take precedence.
  const bytes = new Uint8Array(16); // 2x2 RGBA
  bytes[0] = 0x50;
  bytes[1] = 0x35;
  bytes[4] = 10;
  bytes[7] = 0; // one transparent pixel
  const image = parser.parseImage(bytes, { kind: 'rgba', width: 2, height: 2 });
  assert.equal(image.kind, 'rgba');
  assert.deepEqual(Array.from(image.rgba.subarray(0, 4)), [0x50, 0x35, 0, 0]);
  assert.equal(image.alpha[1], 0);
});

// --- Unified error taxonomy ----------------------------------------------

test('truncated header is TRUNCATED_HEADER', () => {
  expectCode(new Uint8Array([0x50, 0x35]), 'TRUNCATED_HEADER');
  expectCode(new Uint8Array([0x50, 0x35, 0x0a, 0x33]), 'TRUNCATED_HEADER');
  expectCode(fixtures.asciiBytes('P5\n3 3\n'), 'TRUNCATED_HEADER');
});

test('truncated raster is TRUNCATED_RASTER (not a silent partial read)', () => {
  const full = fixtures.isolatedPeakPgm();
  const truncated = full.bytes.subarray(0, full.bytes.length - 1);
  const error = expectCode(truncated, 'TRUNCATED_RASTER');
  assert.equal(error.details.expected, 49);
  assert.equal(error.details.available, 48);
});

test('trailing bytes after the raster are TRAILING_DATA', () => {
  const full = fixtures.isolatedPeakPgm();
  const withExtra = fixtures.concat([full.bytes, new Uint8Array([0, 0, 0])]);
  const error = expectCode(withExtra, 'TRAILING_DATA');
  assert.equal(error.details.extra, 3);
});

test('zero dimension is BAD_DIMENSION, dimension overflow is DIMENSION_OVERFLOW', () => {
  expectCode(fixtures.asciiBytes('P5\n0 3\n255\n'), 'BAD_DIMENSION');
  // 15 digits already exceeds maxPixels and is well past safe arithmetic.
  expectCode(
    fixtures.asciiBytes('P5\n999999999999999 999999999999999\n255\n'),
    'DIMENSION_OVERFLOW'
  );
});

test('unsupported PGM variants and non-PGM magic are rejected', () => {
  expectCode(fixtures.asciiBytes('P2\n1 1\n255\n0\n'), 'UNSUPPORTED_FORMAT');
  expectCode(fixtures.asciiBytes('P6\n1 1\n255\n'), 'UNSUPPORTED_FORMAT');
  expectCode(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'BAD_MAGIC');
  expectCode(new Uint8Array([0x50, 0x39]), 'BAD_MAGIC');
});

test('bad maxval and non-numeric tokens are reported precisely', () => {
  expectCode(fixtures.asciiBytes('P5\n1 1\n0\n\u0000'), 'BAD_MAXVAL');
  expectCode(fixtures.asciiBytes('P5\n1 1\n70000\n\u0000'), 'BAD_MAXVAL');
  expectCode(fixtures.asciiBytes('P5\nx 1\n255\n'), 'BAD_HEADER');
  expectCode(fixtures.asciiBytes('P5\n1x 1\n255\n'), 'BAD_HEADER');
});

// --- Budgets: must reject before allocating a raster ----------------------

test('file budget rejects before parsing', () => {
  const fixture = fixtures.flatPgm();
  const error = expectCode(fixture.bytes, 'FILE_BUDGET_EXCEEDED', {
    limits: { maxFileBytes: 16 },
  });
  assert.equal(error.details.byteLength, fixture.bytes.length);
});

test('pixel budget rejects a huge image before allocating', () => {
  // 4000x4000 = 16M pixels with an 8-bit maxval: 16MB raster is small, but
  // the pixel budget can be set low independently.
  const bytes = fixtures.buildPgm({
    width: 4000,
    height: 4000,
    maxValue: 255,
    samples: new Uint16Array(0), // unused; parser fails before reading raster
  });
  const error = expectCode(bytes, 'PIXEL_BUDGET_EXCEEDED', {
    limits: { maxPixels: 1000, maxFileBytes: 64 * 1024 * 1024 },
  });
  assert.equal(error.details.pixelCount, 16000000);
});

test('raster budget rejects before allocating the sample array', () => {
  const bytes = fixtures.buildPgm({
    width: 1000,
    height: 1000,
    maxValue: 65535,
    samples: new Uint16Array(0),
  });
  const error = expectCode(bytes, 'RASTER_BUDGET_EXCEEDED', {
    limits: { maxPixels: 2000000, maxRasterBytes: 1024 * 1024 },
  });
  assert.equal(error.details.rasterBytes, 2000000);
});

test('budget rejection happens even when the file is truncated (budget wins)', () => {
  // A declared 4000x4000 image with no raster: dimension budget must fire
  // before the truncation check would allocate anything.
  const bytes = fixtures.asciiBytes('P5\n4000 4000\n255\n');
  expectCode(bytes, 'PIXEL_BUDGET_EXCEEDED', {
    limits: { maxPixels: 1000 },
  });
});

test('RGBA budgets and dimension guards share the same taxonomy', () => {
  expectCode(new Uint8Array(4), 'TRUNCATED_RASTER', {
    rgba: true,
    width: 2,
    height: 2,
  });
  expectCode(new Uint8Array(32), 'TRAILING_DATA', {
    rgba: true,
    width: 2,
    height: 2,
  });
  expectCode(new Uint8Array(16), 'BAD_DIMENSION', {
    rgba: true,
    width: 0,
    height: 2,
  });
  expectCode(new Uint8Array(16), 'PIXEL_BUDGET_EXCEEDED', {
    rgba: true,
    width: 4,
    height: 4,
    limits: { maxPixels: 10 },
  });
});

test('every parser failure carries a user message', () => {
  for (let i = 0; i < errors.ERROR_CODES.length; i += 1) {
    const code = errors.ERROR_CODES[i];
    assert.ok(errors.userMessageForCode(code), 'missing user message for ' + code);
  }
});

test('the demo page invalid fixtures raise exactly the documented codes', () => {
  // These are the same builders the page's "边界样本" buttons use, so the
  // reproducible boundary samples in the UI are verified here.
  const invalid = fixtures.list().filter((item) => item.invalid);
  assert.ok(invalid.length >= 4, 'page should offer invalid boundary samples');
  for (const item of invalid) {
    const fixture = fixtures.get(item.id);
    let caught = null;
    try {
      parser.parseImage(fixture.bytes, {
        kind: fixture.format === 'rgba' ? 'rgba' : undefined,
        width: fixture.width,
        height: fixture.height,
        limits: fixture.limits,
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, item.id + ' should throw');
    assert.equal(caught.code, item.expectError, item.id + ' raised ' + caught.code);
  }
});
