/**
 * dsh-token-saver
 *
 * Two deterministic levers, both opt-in through the row's `config`:
 *
 * 1. `tools/post-execute` pruning — a tool result that exceeds a token budget is
 *    replaced, before it is committed to the session log, with a smaller form:
 *    JSON payloads keep their structure (arrays and objects are shortened with a
 *    self-describing `__truncated__` marker), everything else keeps its head and
 *    tail around a marker explaining what was dropped. This is the weakest
 *    mechanism that can shrink a result: it accepts the dispatch outcome and only
 *    rewrites its model-visible content. The saving compounds, because every later
 *    request replays the pruned content instead of the original.
 *
 * 2. `hideTools` — removes named tools from the global registry for every agent
 *    through `ctx.tools.restrict()`, so their JSON schemas stop being sent on
 *    every request. Discovery, lookup, and execution stay aligned: a hidden tool
 *    reads as absent everywhere, and unknown names are ignored instead of failing.
 *
 * Nothing here touches the system prompt, other plugins' contributions, or the
 * message history; billion-context (ACP) folds long conversations at the gateway,
 * and this plugin keeps that fold smaller by producing smaller results in the
 * first place.
 */

export const inject = ['tools']

const DEFAULTS = {
  enabled: true,
  maxResultTokens: 2000,
  headRatio: 0.6,
  minSavedChars: 200,
  keepErrorResults: true,
  skipTools: [],
  hideTools: [],
  toolBudgets: {},
  verbose: false,
}

const MARKER_FLOOR_CHARS = 180
const PRUNE_MARKERS = ['characters were omitted from the middle to save context', 'characters kept (~', '"__truncated__"']

/** Running totals for the current process, reported only through `verbose` logs. */
const stats = { pruned: 0, originalChars: 0, keptChars: 0, originalTokens: 0, keptTokens: 0 }

function clampNumber(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.length > 0)
}

function budgetMap(value) {
  const result = {}
  if (!value || typeof value !== 'object') return result
  for (const [name, raw] of Object.entries(value)) {
    if (typeof name !== 'string' || name.length === 0) continue
    const numeric = Number(raw)
    if (!Number.isFinite(numeric)) continue
    result[name] = Math.floor(Math.min(200000, Math.max(200, numeric)))
  }
  return result
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: config.enabled !== false,
    maxResultTokens: Math.floor(clampNumber(config.maxResultTokens, DEFAULTS.maxResultTokens, 200, 200000)),
    headRatio: clampNumber(config.headRatio, DEFAULTS.headRatio, 0.1, 0.9),
    minSavedChars: Math.floor(clampNumber(config.minSavedChars, DEFAULTS.minSavedChars, 0, 100000)),
    keepErrorResults: config.keepErrorResults !== false,
    skipTools: stringList(config.skipTools),
    hideTools: stringList(config.hideTools),
    toolBudgets: budgetMap(config.toolBudgets),
    verbose: config.verbose === true,
  }
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) || // hangul jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, punctuation
    (code >= 0x3041 && code <= 0x33ff) || // kana, CJK compatibility
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0x1f300 && code <= 0x1f9ff) // emoji blocks
  )
}

/**
 * Cheap, dependency-free size estimate: wide glyphs (CJK, kana, hangul, emoji)
 * cost about one token per character, the rest about one token per 3.6
 * characters. Used only to decide whether a result is worth trimming and to
 * report the saving; it never needs to match a provider tokenizer exactly.
 */
function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let tokens = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    tokens += code > 0xffff || isWide(code) ? 1 : 1 / 3.6
  }
  return Math.ceil(tokens)
}

/** Largest prefix of `text` that ends on a line boundary within `budget` characters. */
function takeHead(text, budget) {
  if (budget <= 0) return ''
  if (budget >= text.length) return text
  const newline = text.lastIndexOf('\n', budget)
  return newline > 0 ? text.slice(0, newline) : text.slice(0, budget)
}

/** Largest suffix of `text` that starts on a line boundary within `budget` characters. */
function takeTail(text, budget) {
  if (budget <= 0) return ''
  const start = text.length - budget
  if (start <= 0) return text
  const newline = text.indexOf('\n', start)
  return newline === -1 ? text.slice(start) : text.slice(newline + 1)
}

function textOnly(content) {
  if (!Array.isArray(content) || content.length === 0) return undefined
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') return undefined
  }
  return content.length === 1 ? content[0].text : content.map((block) => block.text).join('\n')
}

/** A result that already carries one of our markers is left alone (idempotent). */
function alreadyPruned(text) {
  return PRUNE_MARKERS.some((marker) => text.includes(marker))
}

/**
 * Failures do not always arrive as `isError`: a shell tool returns exit code 1 as
 * plain text. Only the opening lines are inspected, so a log that merely mentions
 * an error somewhere in the middle still gets trimmed.
 */
function looksLikeError(text) {
  const head = text.slice(0, 400)
  return (
    /(^|\n)\s*(error|exception|traceback|fatal|fatal error|failed|failure)\b/i.test(head) ||
    /(^|\n)\s*(?:\+\s*)?(?:exit code|exit status)\s*[:=]?\s*[1-9]/i.test(head)
  )
}

/**
 * Shorten a JSON document without breaking it. Arrays keep a prefix of their items
 * and objects keep the keys that fit; both gain a `__truncated__` field describing
 * the omission, so the model can still parse the payload and knows what is missing.
 */
function pruneJson(text, budgetTokens) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  if (Array.isArray(value)) {
    if (value.length < 2) return undefined
    const kept = []
    let used = estimateTokens('[]')
    for (const item of value) {
      const cost = estimateTokens(JSON.stringify(item)) + 1
      if (kept.length > 0 && used + cost > budgetTokens) break
      kept.push(item)
      used += cost
    }
    if (kept.length >= value.length) return undefined
    const document = {
      __truncated__: true,
      kept: kept.length,
      total: value.length,
      note: `kept the first ${kept.length} of ${value.length} array items; re-run the tool with a filter or a smaller range to see the rest`,
      items: kept,
    }
    return JSON.stringify(document)
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length < 2) return undefined
    const kept = {}
    const omitted = []
    let used = estimateTokens('{}')
    for (const [key, entry] of entries) {
      const cost = estimateTokens(key) + estimateTokens(JSON.stringify(entry)) + 4
      if (used + cost > budgetTokens) {
        omitted.push(key)
        continue
      }
      kept[key] = entry
      used += cost
    }
    if (omitted.length === 0) return undefined
    kept.__truncated__ = {
      omittedKeys: omitted.slice(0, 20),
      omittedCount: omitted.length,
      note: 'keys that did not fit the token budget were dropped; re-run the tool to read them individually',
    }
    return JSON.stringify(kept)
  }

  return undefined
}

/**
 * Returns a plan for the replacement content, or undefined when the result should
 * pass through. Conservative on purpose: image/file blocks, unknown shapes, error
 * results, and results whose saving would be swallowed by the marker all stay
 * untouched.
 */
function planPrune(content, exec, result, settings) {
  if (result.isError && settings.keepErrorResults) return undefined
  if (settings.skipTools.includes(exec.name)) return undefined

  const text = textOnly(content)
  if (text === undefined || text === '') return undefined
  if (alreadyPruned(text)) return undefined
  if (settings.keepErrorResults && looksLikeError(text)) return undefined

  const budgetTokens = settings.toolBudgets[exec.name] ?? settings.maxResultTokens
  const totalTokens = estimateTokens(text)
  if (totalTokens <= budgetTokens) return undefined

  const structured = pruneJson(text, budgetTokens)
  if (structured !== undefined && structured.length < text.length * 0.9) {
    return {
      content: [
        {
          type: 'text',
          text:
            structured +
            `\n\n[... JSON shortened to fit ~${budgetTokens} tokens (${text.length} characters before). ` +
            'Re-run the tool with a narrower range if the omitted parts matter. ...]',
        },
      ],
      originalChars: text.length,
      keptChars: structured.length,
      originalTokens: totalTokens,
      keptTokens: estimateTokens(structured),
    }
  }

  const charBudget = Math.floor(text.length * (budgetTokens / totalTokens))
  const omittedChars = text.length - charBudget
  if (omittedChars < Math.max(settings.minSavedChars, MARKER_FLOOR_CHARS)) return undefined

  const head = takeHead(text, Math.max(1, Math.floor(charBudget * settings.headRatio)))
  const tail = takeTail(text, Math.max(1, charBudget - head.length))
  if (head.length + tail.length >= text.length) return undefined

  const keptChars = head.length + tail.length
  const keptTokens = estimateTokens(head + tail)
  const marker =
    `\n\n[... ${keptChars} of ${text.length} characters kept (~${keptTokens} of ~${totalTokens} tokens). ` +
    `${text.length - keptChars} characters were omitted from the middle to save context. ` +
    'Re-run the tool with a narrower range (offset/limit, a tighter pattern, or head/tail) ' +
    'if the omitted middle matters. ...]\n\n'

  return {
    content: [{ type: 'text', text: head + marker + tail }],
    originalChars: text.length,
    keptChars,
    originalTokens: totalTokens,
    keptTokens,
  }
}

export function apply(ctx, rawConfig) {
  const settings = normalizeConfig(rawConfig)
  const logger = ctx.logger

  if (settings.enabled) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        if (decision.kind !== 'accept') return decision
        // A decision that carries a replacement `value` already re-rendered the
        // result; leave it alone rather than mixing two projections.
        if (decision.value !== undefined) return decision
        const plan = planPrune(decision.content ?? result.content, exec, result, settings)
        if (plan === undefined) return decision

        stats.pruned += 1
        stats.originalChars += plan.originalChars
        stats.keptChars += plan.keptChars
        stats.originalTokens += plan.originalTokens
        stats.keptTokens += plan.keptTokens
        if (settings.verbose) {
          logger?.info?.(
            `[token-saver] ${exec.name}: ${plan.originalChars}->${plan.keptChars} chars ` +
              `(~${plan.originalTokens}->~${plan.keptTokens} tokens); ` +
              `lifetime: ${stats.pruned} results, ~${stats.originalTokens - stats.keptTokens} tokens dropped`,
          )
        }
        return { ...decision, content: plan.content }
      } catch (error) {
        if (settings.verbose) logger?.warn?.('[token-saver] left a result unpruned:', error)
        return decision
      }
    })
  }

  if (settings.hideTools.length > 0) {
    let known
    try {
      known = new Set(ctx.tools.definitions().map((definition) => definition.name))
    } catch (error) {
      if (settings.verbose) logger?.warn?.('[token-saver] could not read the tool registry:', error)
      known = new Set()
    }
    const deny = settings.hideTools.filter((name) => known.has(name))
    const unknown = settings.hideTools.filter((name) => !known.has(name))
    if (unknown.length > 0 && settings.verbose) {
      logger?.warn?.(`[token-saver] hideTools ignored unknown tools: ${unknown.join(', ')}`)
    }
    if (deny.length > 0) {
      ctx.effect(() => ctx.tools.restrict({ deny }))
      logger?.info?.(`[token-saver] hidden tools: ${deny.join(', ')}`)
    }
  }

  if (settings.verbose) {
    logger?.info?.(
      `[token-saver] ready: maxResultTokens=${settings.maxResultTokens} headRatio=${settings.headRatio} ` +
        `toolBudgets=${Object.keys(settings.toolBudgets).length}`,
    )
  }
}
