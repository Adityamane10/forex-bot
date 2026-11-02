/**
 * Model registry tests: AI sync (idempotent), promotion quality gate
 * (HIGH-2 regression — a coin-flip model must never be promoted).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Container } from '../core/container';
import { ModelVersion } from '@fx/shared';

function makeVersion(over: Partial<ModelVersion>): ModelVersion {
  return {
    modelVersion: `v-${Math.random().toString(36).slice(2, 8)}`,
    algorithm: 'LIGHTGBM',
    target: 'FUTURE_DIRECTION',
    datasetVersion: 'd',
    featureVersion: 'f1',
    trainingPeriod: { start: 1, end: 2 },
    validationPeriod: { start: 2, end: 3 },
    testPeriod: { start: 3, end: 4 },
    hyperparameters: {},
    metrics: { brier: 0.2, auc: 0.6, profitFactor: 1, expectancy: 0.1, maxDrawdown: 0.2 },
    createdAt: Date.now(),
    status: 'CHALLENGER',
    shadow: true,
    ...over,
  };
}

describe('model registry: sync + quality gate', () => {
  let container: Container;

  beforeAll(async () => {
    container = new Container();
    await container.init();
  }, 60_000);

  afterAll(async () => {
    await container.stop();
  });

  it('syncFromAi registers only champion/challenger models, idempotently', async () => {
    await container.store.deleteMany('modelVersions', {});
    const v1 = makeVersion({ modelVersion: 'ai-1', createdAt: 100 });
    const v2 = makeVersion({ modelVersion: 'ai-2', status: 'ARCHIVED', createdAt: 200 });
    const v3 = makeVersion({ modelVersion: 'ai-3', createdAt: 300 });
    const added1 = await container.models.syncFromAi([v1, v2, v3] as unknown as never[]);
    expect(added1).toBe(2); // ARCHIVED skipped
    const added2 = await container.models.syncFromAi([v1, v3] as unknown as never[]);
    expect(added2).toBe(0); // idempotent
  });

  it('promotion: no champion + subpar challenger (brier >= 0.25) is blocked', async () => {
    await container.store.deleteMany('modelVersions', {});
    await container.models.register(makeVersion({ modelVersion: 'subpar', createdAt: Date.now(), metrics: { brier: 0.3, auc: 0.55 } }));
    const res = await container.models.evaluateChallenger();
    expect(res.promoted).toBe(false);
    expect(res.reason).toContain('quality gate');
  });

  it('promotion: no champion + passing challenger is promoted', async () => {
    await container.store.deleteMany('modelVersions', {});
    await container.models.register(makeVersion({ modelVersion: 'decent', createdAt: Date.now() + 10, metrics: { brier: 0.2, auc: 0.6, profitFactor: 1.2 } }));
    const res = await container.models.evaluateChallenger();
    expect(res.promoted).toBe(true);
    const champ = await container.models.champion();
    expect(champ?.modelVersion).toBe('decent');
  });

  it('promotion: challenger below gate never beats an existing champion', async () => {
    await container.store.deleteMany('modelVersions', {});
    await container.models.register(makeVersion({ modelVersion: 'decent', createdAt: Date.now(), metrics: { brier: 0.2, auc: 0.6, profitFactor: 1.2 } }));
    await container.models.evaluateChallenger(); // promote decent
    await container.models.register(makeVersion({ modelVersion: 'subpar2', createdAt: Date.now() + 20, metrics: { brier: 0.27, auc: 0.52, profitFactor: 99, expectancy: 9, maxDrawdown: 0.001 } }));
    const res = await container.models.evaluateChallenger();
    expect(res.promoted).toBe(false);
    expect(res.reason).toContain('quality gate');
    const champ = await container.models.champion();
    expect(champ?.modelVersion).toBe('decent'); // unchanged
  });
});