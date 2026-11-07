# dsh-token-saver-plugin

A Host-only Harness bundle that keeps tool output from crowding out the context, hides
tool families you never call, and tightens its budget as a session fills up. Every lever
is deterministic: no model call, no extra request, no rewriting of message history.

## What it does

1. **Prunes oversized tool results at the source.** The plugin listens on the
   `tools/post-execute` waterfall. When a result exceeds a token budget it is replaced
   with a smaller form before the session records it, so every later request carries the
   smaller version and the saving compounds on its own:
   - **JSON payloads keep their structure.** Arrays keep a prefix of their items and
     objects keep the keys that fit; both gain a `__truncated__` field that reports what
     was dropped. The model still gets parseable JSON instead of a cut string.
   - **Everything else keeps head and tail** on line boundaries, with a marker that states
     how much was dropped and how to get it back (`offset`/`limit`, a tighter pattern).
   - **Failures stay readable.** Results flagged as errors, and plain-text results whose
     first lines look like a failure (`Error:`, `Traceback`, `exit code: 1`, ...), are left
     intact so a broken run is still diagnosable.
   - **Idempotent.** A result that already carries one of the plugin's markers is never
     trimmed twice, so replayed or re-wrapped results are safe.
2. **Hides whole tool families.** `presets` expands to wildcard patterns and
   `ctx.tools.restrict()` removes the matching tools from the global registry, so their
   JSON schemas are no longer sent with each request. Presets: `browser` (`ego_*`),
   `office` (`office_*`), `schedules` (`schedule_*`), `agents` (subagents and friends).
   `hideTools` still takes exact names and now accepts `*` wildcards. Discovery, lookup,
   and execution stay aligned: a hidden tool reads as absent everywhere, and rules that
   match nothing are ignored instead of failing the plugin.
3. **Adapts the budget to context pressure.** When `ctx.tokenMeter.contextPressure()`
   reports the session is above `highPressure` of its window, the result budget is
   multiplied by `highFactor` (default 0.5); below `lowPressure` it is multiplied by
   `lowFactor` (default 1.5). Without the meter service the factor stays at 1, so the
   plugin degrades to a fixed budget rather than failing.
4. **Bounds inline images.** `dropImagesAboveKB` replaces an oversized image block with a
   one-line placeholder. Pruning otherwise skips any content that carries a non-text
   block, and a single screenshot can cost thousands of tokens.

It is complementary to billion-context (ACP): ACP folds long conversations at the
gateway, and this plugin keeps those folds smaller by producing smaller inputs in the
first place. It also complements the built-in spill of very large shell output to a
temporary file, which only covers one tool family.

## Install

The plugin is a Host-only bundle. It needs a Harness build that exposes the `tools`
service and the `tools/post-execute` waterfall; there is no UI contribution.

```text
# 1) from npm (package name: dsh-token-saver-plugin)
plugin_manager install_bundle target=dsh-token-saver-plugin

# 2) packaged bundle from the latest release
#    https://github.com/SYSTEMMBRBOOT/dsh-token-saver-plugin/releases/latest
plugin_manager install_bundle target=<absolute path to dsh-token-saver-plugin-1.1.0.tgz>

# 3) or point at a checkout / unpacked directory
plugin_manager install_bundle target=<absolute path to dsh-token-saver>
```

The npm package is named `dsh-token-saver-plugin` because the bare name `dsh-token-saver`
is rejected by npm as too similar to the existing `dsh-tokensaver`. The repository uses the
same name.

The packed `.tgz` ships the runtime files only (`index.js`, `package.json`,
`cordis.patch.yml`, `locale/`, `icon.svg`, `README.md`); the test suite stays in the
repository and is not part of the installed bundle.

Installing wires the package into the profile, adds it to `dsh.profile.bundles`, and
applies `cordis.patch.yml`. To change settings afterwards, edit the inserted row's `config`
in the profile patch (or repack with a different default): the defaults below apply when a
key is absent.

## Configuration

`cordis.patch.yml` inserts one row. Every key is optional and validated with clamps, so an
out-of-range value falls back or saturates instead of throwing.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the result pruning off while keeping the rest of the plugin. |
| `maxResultTokens` | `2000` | Budget for one tool result, in tokens (200 to 200000). |
| `headRatio` | `0.6` | Share of the kept budget taken from the start; the rest comes from the end (0.1 to 0.9). |
| `minSavedChars` | `200` | Do not prune when the saving would not pay for the marker. |
| `keepErrorResults` | `true` | Leave failed tool results untouched so failures stay diagnosable. |
| `skipTools` | `[]` | Tool names that must never be pruned. |
| `toolBudgets` | `{}` | Per-tool budget overrides, e.g. `{ pwsh: 1200, grep: 600 }` (200 to 200000 each). |
| `presets` | `[]` | Tool families to hide: `browser`, `office`, `schedules`, `agents`. |
| `hideTools` | `[]` | Exact tool names or `*` wildcards (`ego_*`) removed from the registry. |
| `adaptive.enabled` | `true` | Scale the budget with context pressure. |
| `adaptive.highPressure` | `0.7` | Pressure ratio above which `highFactor` applies. |
| `adaptive.lowPressure` | `0.3` | Pressure ratio below which `lowFactor` applies. |
| `adaptive.highFactor` | `0.5` | Budget multiplier at high pressure. |
| `adaptive.lowFactor` | `1.5` | Budget multiplier at low pressure. |
| `dropImagesAboveKB` | `0` | Replace inline images above this size with a placeholder (0 keeps every image). |
| `verbose` | `false` | Log mount state, hidden tools, skipped results, and a per-result saving line. |

```yaml
- insert:
    - id: dsh-token-saver
      name: dsh-token-saver-plugin
      config:
        maxResultTokens: 2000
        toolBudgets:
          pwsh: 1200
          grep: 600
        skipTools: ['read']
        # A desktop session rarely needs the browser family: 36 schemas saved.
        presets: ['browser', 'office']
        dropImagesAboveKB: 512
```

## What it deliberately does not do

- It never rewrites assistant or user messages, the system prompt, or another plugin's
  contributions. History stays the session log's job.
- It does not implement native deferred tool loading. `ToolSchema.deferLoading` exists, but
  the harness forwards it only to the Anthropic provider as `defer_loading`, which depends
  on that vendor's tool-search round trip; providers without that feature (including
  DeepSeek) cannot use it. Hiding families is the portable substitute.
- It skips results already re-rendered by another `post-execute` listener (`value`
  decisions).
- It does not compress conversations. That remains billion-context's role.

## Verifying it works

1. Install the bundle directory with `plugin_manager` (`install_bundle`), confirm a
   `dsh-token-saver` row is active.
2. Run a tool that returns a large text result (for example `read` on a long file without
   `limit`). The result should end with the `[... N of M characters kept ...]` marker, and
   the card should show the shortened text.
3. Omit the marker by setting `maxResultTokens` far above the output size; the result must
   come back unchanged, which shows the listener only acts above the budget.
4. Ask the agent to re-read the same region with `offset`/`limit`: the suggested recovery
   path must work, because `read` itself is untouched.
5. Set `verbose: true` and check the log line: it reports the per-result saving, the
   effective budget (which shows the adaptive factor), and lifetime totals.

## Limits

- The token estimate is a local heuristic (wide characters and emoji count as about one
  token, others as about one per 3.6 characters), used only to size the cut and report it.
  Trimming is approximate by design.
- Pruning is applied per result, not per turn; a batch of many medium results each below
  the budget is left alone.
- JSON shortening trades completeness for shape: the `__truncated__` field tells the model
  what is missing, but a payload that only fits as a whole still has to be re-read in
  pieces.
- `presets` and `hideTools` apply to the whole profile, including subagents, and stay in
  effect until the row's config changes.
- The adaptive factor needs `ctx.tokenMeter.contextPressure()` to return a numeric
  `pressureTokens` and `contextWindow`; when it does not, the budget stays fixed.
