// Central resource budgets. Every check happens before a large typed array is
// allocated, so an oversized file cannot turn into an out-of-memory crash
// halfway through parsing.

(function (root, factory) {
  'use strict';
  let errors;
  if (typeof module === 'object' && module.exports) {
    errors = require('./errors.js');
  } else {
    errors = root.IWCore.errors;
  }
  const api = factory(errors);
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.limits = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (errors) {
  'use strict';

  const ImageFormatError = errors.ImageFormatError;

  const DEFAULT_LIMITS = Object.freeze({
    maxFileBytes: 32 * 1024 * 1024,
    maxPixels: 8 * 1024 * 1024,
    maxRasterBytes: 32 * 1024 * 1024,
  });

  const LIMIT_KEYS = Object.keys(DEFAULT_LIMITS);

  function resolveLimits(overrides) {
    if (overrides == null) return Object.assign({}, DEFAULT_LIMITS);
    if (typeof overrides !== 'object') {
      throw new ImageFormatError('INVALID_INPUT', 'limits 必须是对象。');
    }
    const limits = Object.assign({}, DEFAULT_LIMITS);
    for (let i = 0; i < LIMIT_KEYS.length; i += 1) {
      const key = LIMIT_KEYS[i];
      if (overrides[key] === undefined) continue;
      const value = overrides[key];
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ImageFormatError(
          'INVALID_INPUT',
          '限制项 ' + key + ' 必须是正整数。',
          { key, value }
        );
      }
      limits[key] = value;
    }
    return limits;
  }

  function assertFileBudget(byteLength, limits) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new ImageFormatError('INVALID_INPUT', '字节长度无效。', {
        byteLength,
      });
    }
    if (byteLength > limits.maxFileBytes) {
      throw new ImageFormatError(
        'FILE_BUDGET_EXCEEDED',
        '文件 ' + byteLength + ' 字节，超过预算 ' + limits.maxFileBytes + ' 字节。',
        { byteLength, maxFileBytes: limits.maxFileBytes }
      );
    }
  }

  // Validates geometry and raster size. Returns { pixelCount, rasterBytes }.
  // Throws a unified error before any pixel array is allocated.
  function assertGeometry(width, height, bytesPerSample, limits) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
      throw new ImageFormatError(
        'DIMENSION_OVERFLOW',
        '图像尺寸不是安全整数。',
        { width, height }
      );
    }
    if (width <= 0 || height <= 0) {
      throw new ImageFormatError('BAD_DIMENSION', '图像宽高必须是正整数。', {
        width,
        height,
      });
    }
    const pixelCount = width * height;
    if (!Number.isSafeInteger(pixelCount)) {
      throw new ImageFormatError('DIMENSION_OVERFLOW', '图像像素数溢出。', {
        width,
        height,
      });
    }
    if (pixelCount > limits.maxPixels) {
      throw new ImageFormatError(
        'PIXEL_BUDGET_EXCEEDED',
        '图像有 ' + pixelCount + ' 像素，超过预算 ' + limits.maxPixels + '。',
        { pixelCount, maxPixels: limits.maxPixels }
      );
    }
    const rasterBytes = pixelCount * bytesPerSample;
    if (!Number.isSafeInteger(rasterBytes)) {
      throw new ImageFormatError(
        'DIMENSION_OVERFLOW',
        '像素栅格字节数溢出。',
        { width, height, bytesPerSample }
      );
    }
    if (rasterBytes > limits.maxRasterBytes) {
      throw new ImageFormatError(
        'RASTER_BUDGET_EXCEEDED',
        '像素栅格需要 ' +
          rasterBytes +
          ' 字节，超过预算 ' +
          limits.maxRasterBytes +
          '。',
        { rasterBytes, maxRasterBytes: limits.maxRasterBytes }
      );
    }
    return { pixelCount, rasterBytes };
  }

  return {
    DEFAULT_LIMITS,
    resolveLimits,
    assertFileBudget,
    assertGeometry,
  };
});
