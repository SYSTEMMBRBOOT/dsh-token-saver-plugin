/**
 * dsh-token-saver
 *
 * Two deterministic levers, both opt-in through the row's `config`:
 *
 * 1. `tools/post-execute` pruning — a tool result that exceeds a token budget is
 *    replaced, before it is committed to the session log, with its head and tail
 *    plus a marker explaining what was dropped. This is the weakest mechanism
 *    that can shrink a result: it accepts the dispatch outcome and only rewrites
 *    its model-visible content. The saving compounds, because every later request
 *    replays the pruned content instead of the original.
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
  verbose: false,
}

const MARKER_FLOOR_CHARS = 180

function clampNumber(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, numeric))
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.length > 0)
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
    verbose: config.verbose === true,
  }
}

/**
 * Cheap, dependency-free size estimate: CJK text costs about one token per
 * character, the rest about one token per 3.6 characters. Used only to decide
 * whether a result is worth trimming and to report the saving; it never needs to
 * match a provider tokenizer exactly.
 */
function estimateTokens(text) {
  let wide = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff01 && code <= 0xff60)
    ) {
      wide += 1
    }
  }
  const narrow = Math.max(0, text.length - wide)
  return wide + Math.ceil(narrow / 3.6)
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

/**
 * Returns replacement content, or undefined when the result should pass through.
 * Conservative on purpose: image/file blocks, unknown shapes, error results, and
 * results whose saving would be swallowed by the marker all stay untouched.
 */
function pruneContent(content, exec, result, settings) {
  if (result.isError && settings.keepErrorResults) return undefined
  if (settings.skipTools.includes(exec.name)) return undefined

  const text = textOnly(content)
  if (text === undefined || text === '') return undefined

  const totalTokens = estimateTokens(text)
  if (totalTokens <= settings.maxResultTokens) return undefined

  const charBudget = Math.floor(text.length * (settings.maxResultTokens / totalTokens))
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

  return [{ type: 'text', text: head + marker + tail }]
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
        const pruned = pruneContent(decision.content ?? result.content, exec, result, settings)
        return pruned === undefined ? decision : { ...decision, content: pruned }
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
      `[token-saver] ready: maxResultTokens=${settings.maxResultTokens} headRatio=${settings.headRatio}`,
    )
  }
}
