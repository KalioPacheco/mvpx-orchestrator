import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/state/store.js';
import { loadCostHistory, recordValidationRepairCost, summarizeCostHistory } from '../dist/cost/history.js';

test('legacy config migrates to current fresh-repair settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvpx-repair-config-'));
  try {
    await mkdir(path.join(root, '.mvpx'), { recursive: true });
    await writeFile(path.join(root, '.mvpx', 'config.json'), JSON.stringify({
      configVersion: 10,
      memoryMaxChars: 18000,
      maxRetries: 3,
    }));
    const config = await loadConfig(root);
    assert.equal(config.configVersion, 13);
    assert.equal(config.finalRepairMemoryMaxChars, 6000);
    assert.equal(config.maxRetries, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validation repair costs are tracked but excluded from planner package profile', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvpx-repair-cost-'));
  try {
    const state = { projectRoot: root };
    await recordValidationRepairCost(
      state,
      'test',
      1,
      'gpt-5.6-terra',
      { turns: 1, inputTokens: 263282, cachedInputTokens: 221440, cacheWriteInputTokens: 0, outputTokens: 1870, reasoningOutputTokens: 536 },
      2,
      true,
      80,
    );
    const rows = await loadCostHistory(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recordType, 'validation-repair');
    assert.equal(rows[0].gateName, 'test');
    assert.equal(rows[0].repairAttempt, 1);
    assert.equal(rows[0].success, true);
    assert.match(summarizeCostHistory(rows), /No historical MVPX implementation cost observations yet/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
