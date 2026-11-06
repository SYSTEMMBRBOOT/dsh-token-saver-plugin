/**
 * Offline checks for the pure decisions in index.js, against a fake Host context.
 * Run: node test/verify.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function fakeContext(toolNames = []) {
  const listeners = new Map()
  const restrictCalls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    effect(setup) {
      const disposer = setup()
      if (disposer !== undefined && typeof disposer !== 'function') {
        throw new Error('effect setup must return a disposer')
      }
      return disposer
    },
    tools: {
      definitions: () => toolNames.map((name) => ({ name })),
      restrict: (filter) => {
        restrictCalls.push(filter)
        return () => {}
      },
    },
  }
  return { ctx, listeners, restrictCalls }
}

async function runPostExecute(ctx, listeners, exec, result) {
  const handler = listeners.get('tools/post-execute')
  assert.equal(typeof handler, 'function', 'post-execute listener registered')
  return handler(exec, result, async () => ({ kind: 'accept' }))
}

function bigText(lines, prefix = 'line') {
  return Array.from({ length: lines }, (_, index) => `${prefix} ${index} ${'x'.repeat(60)}`).join('\n')
}

const cases = []

cases.push(async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, {})
  const text = bigText(400)
  const decision = await runPostExecute(
    ctx,
    listeners,
    { name: 'read', arguments: {} },
    { isError: false, content: [{ type: 'text', text }], value: text },
  )
  assert.equal(decision.kind, 'accept')
  assert.ok(decision.content, 'content replaced')
  const out = decision.content[0].text
  assert.ok(out.length < text.length, 'shorter than the original')
  assert.match(out, /characters kept/, 'marker present')
  assert.match(out, /Re-run the tool with a narrower range/, 'recovery hint present')
  assert.ok(out.startsWith('line 0 '), 'head preserved from the start')
  assert.ok(out.includes('line 399'), 'tail preserved from the end')
  assert.ok(out.split('\n').length < text.split('\n').length, 'middle dropped')
})

cases.push(async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, {})
  const text = bigText(5)
  const result = { isError: false, content: [{ type: 'text', text }] }
  const decision = await runPostExecute(ctx, listeners, { name: 'read' }, result)
  assert.equal(decision.content, undefined, 'small result untouched')
})

cases.push(async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, {})
  const text = bigText(400)
  const result = { isError: true, content: [{ type: 'text', text }] }
  const decision = await runPostExecute(ctx, listeners, { name: 'pwsh' }, result)
  assert.equal(decision.content, undefined, 'error result untouched by default')
})

cases.push(async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, { skipTools: ['pwsh'] })
  const text = bigText(400)
  const result = { isError: false, content: [{ type: 'text', text }] }
  const decision = await runPostExecute(ctx, listeners, { name: 'pwsh' }, result)
  assert.equal(decision.content, undefined, 'skipTools honoured')
})

cases.push(async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, {})
  const result = {
    isError: false,
    content: [{ type: 'text', text: bigText(400) }, { type: 'image', attachment: {} }],
  }
  const decision = await runPostExecute(ctx, listeners, { name: 'screenshot' }, result)
  assert.equal(decision.content, undefined, 'non-text content untouched')
})

cases.push(async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, { maxResultTokens: 500, headRatio: 0.5 })
  const text = bigText(400)
  const decision = await runPostExecute(
    ctx,
    listeners,
    { name: 'read' },
    { isError: false, content: [{ type: 'text', text }] },
  )
  const out = decision.content[0].text
  const keptChars = out.length
  assert.ok(keptChars < text.length * 0.55, `tight budget kept ${keptChars} of ${text.length}`)
})

cases.push(async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(listeners.get('tools/post-execute'), undefined, 'disabled means no listener')
})

cases.push(async () => {
  const { ctx, restrictCalls } = fakeContext(['read', 'pwsh'])
  apply(ctx, { hideTools: ['pwsh', 'no-such-tool'] })
  assert.deepEqual(restrictCalls, [{ deny: ['pwsh'] }], 'known tools denied, unknown ignored')
})

cases.push(async () => {
  const { ctx, restrictCalls } = fakeContext(['read'])
  apply(ctx, { hideTools: ['ghost'] })
  assert.equal(restrictCalls.length, 0, 'nothing denied when no name resolves')
})

cases.push(async () => {
  const { ctx, listeners } = fakeContext()
  apply(ctx, {})
  const text = bigText(400)
  const decision = await runPostExecute(
    ctx,
    listeners,
    { name: 'read' },
    { isError: false, content: [{ type: 'text', text }] },
  )
  assert.equal(decision.additionalContexts, undefined, 'no extra context injected')
  assert.equal(decision.value, undefined, 'value stays unset')
})

for (const [index, testCase] of cases.entries()) {
  await testCase()
  console.log(`ok ${index + 1}`)
}
console.log(`${cases.length} checks passed`)
