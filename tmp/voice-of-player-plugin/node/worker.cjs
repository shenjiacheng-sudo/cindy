'use strict';

const readline = require('node:readline');
const { runFixtureAnalysis, findEvidence } = require('./pipeline.cjs');
const { normalizePublicReviewPages } = require('./public-review-collector.cjs');

function reply(id, result, error) {
  const message = { jsonrpc: '2.0', id };
  if (error) message.error = { code: -32000, message: error.message || String(error) };
  else message.result = result;
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handle(request) {
  try {
    if (!request || request.jsonrpc !== '2.0') throw new Error('INVALID_JSON_RPC');
    const result = runFixtureAnalysis();
    if (request.method === 'load_player_feedback_fixture' || request.method === 'analyze_player_feedback') return result;
    if (request.method === 'get_feedback_evidence') {
      const reference = request.params && request.params.reference;
      if (typeof reference !== 'string' || !reference.trim()) throw new Error('REFERENCE_REQUIRED');
      return findEvidence(result, reference.trim());
    }
    if (request.method === 'normalize_public_reviews') {
      const params = request.params || {};
      if (!Array.isArray(params.pages)) throw new Error('PUBLIC_REVIEW_PAGES_REQUIRED');
      return normalizePublicReviewPages(params.pages, { appId: params.appId });
    }
    throw new Error('METHOD_NOT_FOUND');
  } catch (error) {
    return { __error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// Cindy 的 Node 引导层会 require() manifest 声明的 entry；本地直接执行时则
// require.main === module。两种入口都必须启动 stdio 服务，但被测试文件 require
// 时不能占住测试进程的 stdin。
const isNodeWorkerEntry = require.main === module || process.argv[2] === __filename;
if (isNodeWorkerEntry) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let request;
    try { request = JSON.parse(line); } catch (error) { reply(null, null, new Error('INVALID_JSON')); return; }
    const result = handle(request);
    if (result && result.__error) reply(request.id, null, result.__error);
    else reply(request.id, result);
  });
}

module.exports = { handle };
