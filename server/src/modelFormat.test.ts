import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelLabel, modelTier } from '../../web/src/lib/format.ts'

test('modelLabel: ID đầy đủ, alias, không khớp, rỗng', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelLabel('claude-sonnet-5'), 'Sonnet 5')
  assert.equal(modelLabel('claude-haiku-4-5'), 'Haiku 4.5')
  assert.equal(modelLabel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5')
  assert.equal(modelLabel('claude-opus-5-5[1m]'), 'Opus 5.5')
  assert.equal(modelLabel('opus'), 'Opus')
  assert.equal(modelLabel('haiku'), 'Haiku')
  assert.equal(modelLabel('claude-fable-5-2'), 'claude-fable-5-2')
  assert.equal(modelLabel('gpt-4'), 'gpt-4')
  assert.equal(modelLabel(undefined), '—')
  assert.equal(modelLabel(''), '—')
})

test('modelTier', () => {
  assert.equal(modelTier('claude-opus-5-5'), 'opus')
  assert.equal(modelTier('claude-sonnet-5'), 'sonnet')
  assert.equal(modelTier('claude-haiku-4-5'), 'haiku')
  assert.equal(modelTier('sonnet'), 'sonnet')
  assert.equal(modelTier('claude-fable-5-2'), 'other')
  assert.equal(modelTier(undefined), 'other')
})
