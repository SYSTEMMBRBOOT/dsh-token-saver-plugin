/**
 * dsh-token-saver
 *
 * Deterministic levers, all opt-in through the row's `config`:
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
 * 2. `presets` / `hideTools` — removes whole tool families (or exact names, with
 *    `*` wildcards) from the global registry for every agent through
 *    `ctx.tools.restrict()`, so their JSON schemas stop being sent on every
 *    request. Discovery, lookup, and execution stay aligned: a hidden tool reads as
 *    absent everywhere, and unknown names are ignored instead of failing.
 *
 * 3. `adaptive` — when a session is close to its context window, the result budget
 *    is tightened; when it is nearly empty, the budget is relaxed. The pressure
 *    reading comes from `ctx.tokenMeter.contextPressure()`; when that service is
 *    unavailable the factor stays at 1.
 *
 * 4. `dropImagesAboveKB` — optionally replaces an oversized inline image block with
 *    a one-line placeholder, the one result shape pruning otherwise skips.
 *
 * Nothing here touches the system prompt, other plugins' contributions, or the
 * message history; billion-context (ACP) folds long conversations at the gateway,
 * and this plugin keeps that fold smaller by producing smaller results in the
 * first place.
 *
 * Note on native deferred loading: `ToolSchema.deferLoading` exists, but the
 * harness only forwards it to the Anthropic provider as `defer_loading`, which
 * depends on that vendor's tool-search/tool_reference round trip. Providers
 * without that feature (including DeepSeek) cannot use it, which is why tool-family
 * hiding is the lever offered here instead.
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
  presets: [],
  toolBudgets: {},
  adaptive: { enabled: true, highPressure: 0.7, lowPressure: 0.3, highFactor: 0.5, lowFactor: 1.5 },
  dropImagesAboveKB: 0,
  verbose: false,
}

/** Named tool families. Every entry is a wildcard pattern list. */
const PRESETS = {
  browser: ['ego_*'],
  office: ['office_*'],
  schedules: ['schedule_*'],
  agents: [
    'subagent',
    'subagent_fork',
    'send_message',
    'interrupt_agent',
    'list_agents',
    'list_subagent_models',
    'workflow',
  ],
}

const MARKER_FLOOR_CHARS = 180
const PRUNE_MARKERS = ['characters were omitted from the middle to save context', 'characters kept (~', '"__truncated__"']

/** Running totals for the current process, reported only through `verbose` logs. */
const stats = { pruned: 0, originalChars: 0, keptChars: 0, originalTokens: 0, keptTokens: 0, images: 0 }

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

function normalizeAdaptive(value) {
  const raw = value && typeof value === 'object' ? value : {}
  return {
    enabled: raw.enabled !== false,
    highPressure: clampNumber(raw.highPressure, DEFAULTS.adaptive.highPressure, 0.1, 1),
    lowPressure: clampNumber(raw.lowPressure, DEFAULTS.adaptive.lowPressure, 0, 0.99),
    highFactor: clampNumber(raw.highFactor, DEFAULTS.adaptive.highFactor, 0.1, 1),
    lowFactor: clampNumber(raw.lowFactor, DEFAULTS.adaptive.lowFactor, 1, 4),
  }
}

/** Preset names expand to patterns; unknown preset names are reported, not fatal. */
function expandPresets(names) {
  const patterns = []
  const unknown = []
  for (const name of names) {
    const preset = PRESETS[name]
    if (preset === undefined) unknown.push(name)
    else patterns.push(...preset)
  }
  return { patterns, unknown }
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const adaptive = normalizeAdaptive(config.adaptive)
  // Keep the documented ordering sane: tighten before relaxing.
  if (adaptive.lowPressure > adaptive.highPressure) adaptive.lowPressure = adaptive.highPressure
  return {
    enabled: config.enabled !== false,
    maxResultTokens: Math.floor(clampNumber(config.maxResultTokens, DEFAULTS.maxResultTokens, 200, 200000)),
    headRatio: clampNumber(config.headRatio, DEFAULTS.headRatio, 0.1, 0.9),
    minSavedChars: Math.floor(clampNumber(config.minSavedChars, DEFAULTS.minSavedChars, 0, 100000)),
    keepErrorResults: config.keepErrorResults !== false,
    skipTools: stringList(config.skipTools),
    hideTools: stringList(config.hideTools),
    presets: stringList(config.presets),
    toolBudgets: budgetMap(config.toolBudgets),
    adaptive,
    dropImagesAboveKB: Math.floor(clampNumber(config.dropImagesAboveKB, DEFAULTS.dropImagesAboveKB, 0, 102400)),
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

/** Rough byte size of an inline image block, or 0 when the shape is unknown. */
function imageBytes(block) {
  const base64 =
    typeof block.data === 'string' ? block.data : typeof block.source?.data === 'string' ? block.source.data : undefined
  if (base64 === undefined) return 0
  return Math.floor((base64.length * 3) / 4)
}

/**
 * Replace images above `dropImagesAboveKB` with a placeholder. A single screenshot
 * can cost thousands of tokens, and pruning skips any content that carries a
 * non-text block, so this is the only way to bound image-heavy results.
 */
function dropOversizedImages(content, settings) {
  if (!(settings.dropImagesAboveKB > 0) || !Array.isArray(content)) return undefined
  let changed = false
  let keptTokens = 0
  let originalTokens = 0
  const next = content.map((block) => {
    if (!block || block.type !== 'image') return block
    const bytes = imageBytes(block)
    if (bytes <= settings.dropImagesAboveKB * 1024) return block
    changed = true
    const kb = Math.round(bytes / 1024)
    const placeholder = {
      type: 'text',
      text:
        `[image omitted to save context: ~${kb} KB, above dropImagesAboveKB=${settings.dropImagesAboveKB}. ` +
        'Raise the limit (or set it to 0) to keep images.]',
    }
    // Base64 text costs roughly one token per four characters, i.e. three per byte.
    originalTokens += Math.round(bytes / 3)
    keptTokens += estimateTokens(placeholder.text)
    return placeholder
  })
  return changed ? { content: next, originalTokens: Math.round(originalTokens), keptTokens } : undefined
}

/** `*` wildcards let one pattern cover a family without listing every name. */
function matchesPattern(name, pattern) {
  if (!pattern.includes('*')) return name === pattern
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(name)
}

/**
 * Ratio of the session's context window that is currently in use, or undefined
 * when the meter service is missing or the session handle is not reachable.
 */
function pressureRatio(ctx, exec) {
  try {
    const session = exec?.session ?? exec?.agent?.session
    if (session === undefined) return undefined
    const reading = ctx.tokenMeter?.contextPressure?.(session)
    const used = reading?.pressureTokens
    const window = reading?.contextWindow
    if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return undefined
    return used / window
  } catch {
    return undefined
  }
}

/** Budget multiplier for this result, derived from context pressure. */
function adaptiveFactor(ctx, exec, settings) {
  const adaptive = settings.adaptive
  if (!adaptive.enabled) return 1
  const ratio = pressureRatio(ctx, exec)
  if (ratio === undefined) return 1
  if (ratio >= adaptive.highPressure) return adaptive.highFactor
  if (ratio <= adaptive.lowPressure) return adaptive.lowFactor
  return 1
}

/**
 * Returns a plan for the replacement content, or undefined when the result should
 * pass through. Conservative on purpose: unknown shapes, error results, and results
 * whose saving would be swallowed by the marker all stay untouched.
 */
function planPrune(content, exec, result, settings, factor) {
  if (result.isError && settings.keepErrorResults) return undefined
  if (settings.skipTools.includes(exec.name)) return undefined

  const text = textOnly(content)
  if (text === undefined || text === '') return undefined
  if (alreadyPruned(text)) return undefined
  if (settings.keepErrorResults && looksLikeError(text)) return undefined

  const base = settings.toolBudgets[exec.name] ?? settings.maxResultTokens
  const budgetTokens = Math.max(200, Math.round(base * factor))
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
      budgetTokens,
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
    budgetTokens,
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

        const original = decision.content ?? result.content
        const images = dropOversizedImages(original, settings)
        const working = images ? images.content : original
        const factor = adaptiveFactor(ctx, exec, settings)
        const plan = planPrune(working, exec, result, settings, factor)

        if (plan === undefined && images === undefined) return decision

        if (images !== undefined) {
          stats.images += 1
          stats.originalTokens += images.originalTokens
          stats.keptTokens += images.keptTokens
        }
        if (plan !== undefined) {
          stats.pruned += 1
          stats.originalChars += plan.originalChars
          stats.keptChars += plan.keptChars
          stats.originalTokens += plan.originalTokens
          stats.keptTokens += plan.keptTokens
        }
        if (settings.verbose) {
          const parts = []
          if (plan !== undefined) {
            parts.push(
              `${plan.originalChars}->${plan.keptChars} chars (~${plan.originalTokens}->~${plan.keptTokens} tokens, budget ${plan.budgetTokens})`,
            )
          }
          if (images !== undefined) parts.push(`dropped ${images.content.length ? 'oversized image(s)' : 'image'}`)
          logger?.info?.(
            `[token-saver] ${exec.name}: ${parts.join('; ')}; ` +
              `lifetime: ${stats.pruned} results, ${stats.images} image drops, ` +
              `~${stats.originalTokens - stats.keptTokens} tokens dropped`,
          )
        }
        return { ...decision, content: plan !== undefined ? plan.content : working }
      } catch (error) {
        if (settings.verbose) logger?.warn?.('[token-saver] left a result unpruned:', error)
        return decision
      }
    })
  }

  const deny = resolveDenyList(ctx, settings, logger)
  if (deny.length > 0) {
    ctx.effect(() => ctx.tools.restrict({ deny }))
    logger?.info?.(`[token-saver] hidden tools: ${deny.join(', ')}`)
  }

  if (settings.verbose) {
    logger?.info?.(
      `[token-saver] ready: maxResultTokens=${settings.maxResultTokens} headRatio=${settings.headRatio} ` +
        `toolBudgets=${Object.keys(settings.toolBudgets).length} presets=${settings.presets.join(',') || 'none'} ` +
        `adaptive=${settings.adaptive.enabled ? 'on' : 'off'} dropImagesAboveKB=${settings.dropImagesAboveKB}`,
    )
  }
}

/** Exact names plus preset/wildcard matches, filtered to tools that really exist. */
function resolveDenyList(ctx, settings, logger) {
  const { patterns, unknown } = expandPresets(settings.presets)
  if (unknown.length > 0) {
    logger?.warn?.(`[token-saver] unknown presets ignored: ${unknown.join(', ')}`)
  }
  const rules = [...settings.hideTools, ...patterns]
  if (rules.length === 0) return []

  let known
  try {
    known = new Set(ctx.tools.definitions().map((definition) => definition.name))
  } catch (error) {
    if (settings.verbose) logger?.warn?.('[token-saver] could not read the tool registry:', error)
    return []
  }

  const deny = [...known].filter((name) => rules.some((rule) => matchesPattern(name, rule)))
  if (settings.verbose) {
    const matched = new Set(deny)
    const stale = rules.filter((rule) => !rule.includes('*') && !matched.has(rule))
    if (stale.length > 0) logger?.warn?.(`[token-saver] hideTools matched no tool: ${stale.join(', ')}`)
  }
  return deny
}
