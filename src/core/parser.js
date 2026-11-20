// Binary PGM (P5) and raw RGBA buffer parsing.
//
// The parser deliberately keeps three things separate:
//   1. comments   — `#` to end of line, allowed between header tokens
//   2. whitespace — token separators; exactly one byte terminates the header
//   3. pixel start — the byte immediately after that one terminator
//
// A raster whose first byte happens to be a space or `#` is therefore still
// pixel data, not header trivia. Sizes and budgets are checked before any
// typed array is allocated, and every failure is an ImageFormatError.

(function (root, factory) {
  'use strict';
  let errors;
  let limits;
  if (typeof module === 'object' && module.exports) {
    errors = require('./errors.js');
    limits = require('./limits.js');
  } else {
    errors = root.IWCore.errors;
    limits = root.IWCore.limits;
  }
  const api = factory(errors, limits);
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.parser = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (errors, limits) {
  'use strict';

  const ImageFormatError = errors.ImageFormatError;
  const resolveLimits = limits.resolveLimits;
  const assertFileBudget = limits.assertFileBudget;
  const assertGeometry = limits.assertGeometry;

  const WS_SPACE = 0x20;
  const WS_TAB = 0x09;
  const WS_LF = 0x0a;
  const WS_VT = 0x0b;
  const WS_FF = 0x0c;
  const WS_CR = 0x0d;
  const HASH = 0x23;

  function isWhitespace(byte) {
    return (
      byte === WS_SPACE ||
      byte === WS_TAB ||
      byte === WS_LF ||
      byte === WS_VT ||
      byte === WS_FF ||
      byte === WS_CR
    );
  }

  function isDigit(byte) {
    return byte >= 0x30 && byte <= 0x39;
  }

  function asUint8(input, label) {
    const name = label || '输入';
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new ImageFormatError(
      'INVALID_INPUT',
      name + '必须是 ArrayBuffer 或 Uint8Array。'
    );
  }

  // Sniffs the magic without allocating. Returns 'pgm' for P5, null otherwise.
  function sniffFormat(input) {
    let bytes;
    try {
      bytes = asUint8(input);
    } catch (e) {
      return null;
    }
    if (bytes.length < 2) return null;
    if (bytes[0] === 0x50 && bytes[1] === 0x35) return 'pgm';
    return null;
  }

  function readHeader(bytes) {
    let offset = 0;
    const length = bytes.length;

    function fail(code, message, details) {
      throw new ImageFormatError(code, message, details);
    }

    // Comments are consumed only while explicitly between header tokens; the
    // raster is never scanned for them.
    function skipTrivia() {
      while (offset < length) {
        const byte = bytes[offset];
        if (isWhitespace(byte)) {
          offset += 1;
          continue;
        }
        if (byte === HASH) {
          offset += 1;
          while (
            offset < length &&
            bytes[offset] !== WS_LF &&
            bytes[offset] !== WS_CR
          ) {
            offset += 1;
          }
          continue;
        }
        break;
      }
    }

    function readTokenInteger(name) {
      skipTrivia();
      if (offset >= length) {
        fail('TRUNCATED_HEADER', '文件头在' + name + '之前结束。', { field: name });
      }
      if (!isDigit(bytes[offset])) {
        fail('BAD_HEADER', name + '必须是十进制数字。', {
          field: name,
          byte: bytes[offset],
        });
      }
      let value = 0;
      let digits = 0;
      while (offset < length && isDigit(bytes[offset])) {
        const digit = bytes[offset] - 0x30;
        digits += 1;
        if (digits > 15) {
          fail('DIMENSION_OVERFLOW', name + '数值位数过多。', { field: name });
        }
        value = value * 10 + digit;
        if (!Number.isSafeInteger(value)) {
          fail('DIMENSION_OVERFLOW', name + '数值溢出安全整数范围。', {
            field: name,
          });
        }
        offset += 1;
      }
      if (offset >= length) {
        fail('TRUNCATED_HEADER', '文件头在' + name + '之后结束。', { field: name });
      }
      const next = bytes[offset];
      if (!isWhitespace(next) && next !== HASH) {
        fail('BAD_HEADER', name + '之后缺少分隔符。', {
          field: name,
          byte: next,
        });
      }
      return value;
    }

    if (length < 2) {
      fail('BAD_MAGIC', '文件为空或不足两个字节。', { length });
    }
    if (bytes[0] !== 0x50) {
      fail('BAD_MAGIC', '文件不是 PGM。', { magic: [bytes[0], bytes[1]] });
    }
    const magicByte = bytes[1];
    if (magicByte !== 0x35) {
      if (magicByte >= 0x31 && magicByte <= 0x36) {
        fail(
          'UNSUPPORTED_FORMAT',
          '收到 P' + String.fromCharCode(magicByte) + '，仅支持二进制 P5。',
          { magic: 'P' + String.fromCharCode(magicByte) }
        );
      }
      fail('BAD_MAGIC', '文件不是 PGM。', { magic: [bytes[0], bytes[1]] });
    }
    offset = 2;
    if (offset >= length) {
      fail('TRUNCATED_HEADER', '文件头在魔数之后结束。');
    }
    if (!isWhitespace(bytes[offset])) {
      fail('BAD_HEADER', '魔数之后缺少空白分隔符。', { byte: bytes[offset] });
    }

    const width = readTokenInteger('宽度');
    const height = readTokenInteger('高度');
    const maxValue = readTokenInteger('最大灰度值');

    // Exactly one whitespace byte terminates the header. `\r\n` is treated as
    // a single conventional terminator; otherwise every following byte is
    // raster data — including one that happens to be a space or `#`. A `#`
    // directly after maxval is rejected rather than silently swallowed,
    // because comments are only allowed *between* header tokens.
    const terminator = bytes[offset];
    if (!isWhitespace(terminator)) {
      fail('BAD_HEADER', '最大灰度值之后必须紧跟一个空白字节。', {
        byte: terminator,
      });
    }
    offset += 1;
    if (terminator === WS_CR && offset < length && bytes[offset] === WS_LF) {
      offset += 1;
    }

    return { width, height, maxValue, pixelStart: offset };
  }

  function parsePgm(input, options) {
    const opts = options || {};
    const bytes = asUint8(input);
    const limitSet = resolveLimits(opts.limits);
    assertFileBudget(bytes.length, limitSet);

    const header = readHeader(bytes);
    const width = header.width;
    const height = header.height;
    const maxValue = header.maxValue;
    const pixelStart = header.pixelStart;

    if (maxValue < 1 || maxValue > 65535) {
      throw new ImageFormatError(
        'BAD_MAXVAL',
        '最大灰度值 ' + maxValue + ' 不在 1..65535。',
        { maxValue }
      );
    }
    const bitsPerSample = maxValue < 256 ? 8 : 16;
    const bytesPerSample = bitsPerSample / 8;
    const geometry = assertGeometry(
      width,
      height,
      bytesPerSample,
      limitSet
    );
    const pixelCount = geometry.pixelCount;
    const rasterBytes = geometry.rasterBytes;

    const available = bytes.length - pixelStart;
    if (available < rasterBytes) {
      throw new ImageFormatError(
        'TRUNCATED_RASTER',
        '需要 ' +
          rasterBytes +
          ' 字节像素数据，实际只有 ' +
          available +
          ' 字节。',
        { expected: rasterBytes, available, pixelStart }
      );
    }
    if (available > rasterBytes) {
      throw new ImageFormatError(
        'TRAILING_DATA',
        '像素数据之后还有 ' + (available - rasterBytes) + ' 个多余字节。',
        { expected: rasterBytes, available, extra: available - rasterBytes }
      );
    }

    let samples;
    if (bitsPerSample === 8) {
      samples = new Uint8Array(pixelCount);
      samples.set(bytes.subarray(pixelStart, pixelStart + pixelCount));
    } else {
      samples = new Uint16Array(pixelCount);
      let cursor = pixelStart;
      for (let i = 0; i < pixelCount; i += 1) {
        // Big-endian: high byte first; raw 16-bit sample preserved verbatim.
        samples[i] = (bytes[cursor] << 8) | bytes[cursor + 1];
        cursor += 2;
      }
    }

    return {
      kind: 'pgm',
      format: 'pgm-p5',
      width,
      height,
      maxValue,
      bitsPerSample,
      bytesPerSample,
      pixelCount,
      pixelStart,
      headerBytes: pixelStart,
      fileBytes: bytes.length,
      samples,
      rgba: null,
      alpha: null,
    };
  }

  function validateDimension(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      const details = {};
      details[name] = value;
      throw new ImageFormatError('BAD_DIMENSION', name + '必须是正整数。', details);
    }
  }

  // Raw RGBA buffer: dimensions are supplied out of band (there is no header).
  // Layout is tightly packed R,G,B,A bytes, row-major, alpha preserved.
  function parseRgbaRaw(input, options) {
    const opts = options || {};
    const bytes = asUint8(input, 'RGBA 缓冲');
    const limitSet = resolveLimits(opts.limits);
    assertFileBudget(bytes.length, limitSet);
    const width = opts.width;
    const height = opts.height;
    validateDimension(width, '宽度');
    validateDimension(height, '高度');

    const geometry = assertGeometry(width, height, 4, limitSet);
    const pixelCount = geometry.pixelCount;
    const rasterBytes = geometry.rasterBytes;
    if (bytes.length < rasterBytes) {
      throw new ImageFormatError(
        'TRUNCATED_RASTER',
        'RGBA 缓冲需要 ' + rasterBytes + ' 字节，实际只有 ' + bytes.length + ' 字节。',
        { expected: rasterBytes, available: bytes.length }
      );
    }
    if (bytes.length > rasterBytes) {
      throw new ImageFormatError(
        'TRAILING_DATA',
        'RGBA 缓冲之后还有 ' + (bytes.length - rasterBytes) + ' 个多余字节。',
        {
          expected: rasterBytes,
          available: bytes.length,
          extra: bytes.length - rasterBytes,
        }
      );
    }

    const rgba = new Uint8Array(rasterBytes);
    rgba.set(bytes.subarray(0, rasterBytes));

    return {
      kind: 'rgba',
      format: 'rgba-raw',
      width,
      height,
      maxValue: 255,
      bitsPerSample: 8,
      bytesPerSample: 4,
      channels: 4,
      pixelCount,
      pixelStart: 0,
      headerBytes: 0,
      fileBytes: bytes.length,
      samples: null,
      rgba,
      alpha: extractAlpha(rgba, pixelCount),
    };
  }

  function extractAlpha(rgba, pixelCount) {
    const alpha = new Uint8Array(pixelCount);
    for (let i = 0, offset = 3; i < pixelCount; i += 1, offset += 4) {
      alpha[i] = rgba[offset];
    }
    return alpha;
  }

  // Single entry point used by the UI: pick the parser from an explicit
  // declaration first, then fall back to magic-byte sniffing.
  //
  // The explicit `kind: 'rgba'` (set from the .rgba/.bin extension) MUST win
  // over sniffing: a raw RGBA buffer is arbitrary bytes, so its first two
  // bytes can legitimately be 0x50 0x35 ("P5") when R=80, G=53. Routing such
  // a buffer to the PGM parser would reject a perfectly valid image.
  function parseImage(input, options) {
    const opts = options || {};
    const bytes = asUint8(input);
    if (opts.kind === 'rgba') {
      return parseRgbaRaw(bytes, opts);
    }
    if (sniffFormat(bytes) === 'pgm') {
      return parsePgm(bytes, opts);
    }
    if (opts.width != null || opts.height != null) {
      return parseRgbaRaw(bytes, opts);
    }
    throw new ImageFormatError(
      'BAD_MAGIC',
      '无法识别的输入：不是二进制 PGM（P5），也不是声明了宽高的 RGBA 原始缓冲。'
    );
  }

  // Worker-friendly payload: only plain data and typed arrays.
  function toTransferable(image) {
    return {
      kind: image.kind,
      format: image.format,
      width: image.width,
      height: image.height,
      maxValue: image.maxValue,
      bitsPerSample: image.bitsPerSample,
      bytesPerSample: image.bytesPerSample,
      pixelCount: image.pixelCount,
      samples: image.samples,
      rgba: image.rgba,
      alpha: image.alpha,
    };
  }

  return {
    parsePgm,
    parseRgbaRaw,
    parseImage,
    sniffFormat,
    toTransferable,
    extractAlpha,
    isWhitespace,
  };
});
