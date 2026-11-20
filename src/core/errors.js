// Shared error taxonomy for the parser and the compute pipeline.
// Every user-visible failure is an ImageFormatError with a stable `code`, so
// the UI, the worker protocol and the Node tests agree on one contract.
//
// UMD: attaches to globalThis.IWCore for classic <script>/worker use and also
// exports via module.exports for Node tests.

(function (root, factory) {
  'use strict';
  const api = factory();
  root.IWCore = root.IWCore || {};
  Object.assign(root.IWCore, api);
  root.IWCore.errors = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ERROR_DEFINITIONS = {
    INVALID_INPUT: { userMessage: '输入不是可解析的二进制数据。' },
    FILE_BUDGET_EXCEEDED: { userMessage: '文件超过大小预算，未开始解析。' },
    PIXEL_BUDGET_EXCEEDED: { userMessage: '图像像素数超过预算，未分配像素数组。' },
    RASTER_BUDGET_EXCEEDED: { userMessage: '像素栅格超过内存预算，未分配像素数组。' },
    DIMENSION_OVERFLOW: { userMessage: '图像尺寸溢出，未分配像素数组。' },
    BAD_MAGIC: {
      userMessage: '无法识别的文件格式，仅支持二进制 PGM（P5）与 RGBA 原始缓冲。',
    },
    UNSUPPORTED_FORMAT: { userMessage: '该 PGM 变体不受支持，请使用二进制 P5。' },
    BAD_HEADER: { userMessage: '文件头格式错误。' },
    BAD_DIMENSION: { userMessage: '图像宽高必须是正整数。' },
    BAD_MAXVAL: { userMessage: '最大灰度值必须在 1 到 65535 之间。' },
    TRUNCATED_HEADER: { userMessage: '文件头不完整。' },
    TRUNCATED_RASTER: { userMessage: '像素数据不完整（截断）。' },
    TRAILING_DATA: { userMessage: '像素数据之后存在多余字节。' },
    PIPELINE_CANCELLED: { userMessage: '计算已取消。' },
    PIPELINE_FAILED: { userMessage: '计算流水线执行失败。' },
    WORKER_FAILED: { userMessage: '计算 Worker 异常退出。' },
    BAD_JOB: { userMessage: '任务版本无效。' },
  };

  const ERROR_CODES = Object.freeze(Object.keys(ERROR_DEFINITIONS));

  class ImageFormatError extends Error {
    constructor(code, message, details) {
      const definition = ERROR_DEFINITIONS[code];
      super(message || (definition && definition.userMessage) || code);
      this.name = 'ImageFormatError';
      this.code = code;
      this.userMessage =
        (definition && definition.userMessage) || this.message;
      this.details = details || {};
    }
  }

  function isImageFormatError(error) {
    return error instanceof ImageFormatError && typeof error.code === 'string';
  }

  function toErrorPayload(error, fallbackCode) {
    const code = fallbackCode || 'PIPELINE_FAILED';
    if (error instanceof ImageFormatError) {
      return {
        code: error.code,
        message: error.message,
        userMessage: error.userMessage,
        details: error.details,
      };
    }
    return {
      code,
      message: (error && error.message) || String(error),
      userMessage:
        (ERROR_DEFINITIONS[code] && ERROR_DEFINITIONS[code].userMessage) ||
        '发生未知错误。',
      details: {},
    };
  }

  function userMessageForCode(code) {
    return (
      (ERROR_DEFINITIONS[code] && ERROR_DEFINITIONS[code].userMessage) ||
      '发生未知错误。'
    );
  }

  return {
    ImageFormatError,
    isImageFormatError,
    toErrorPayload,
    userMessageForCode,
    ERROR_CODES,
    ERROR_DEFINITIONS,
  };
});
