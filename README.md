# dsh-token-saver

A Host-only Harness bundle that keeps tool output from crowding out the context, and can
drop tool schemas you never call. Both levers are deterministic: no model call, no extra
request, no rewriting of message history.

## What it does

1. **Prunes oversized tool results at the source.** The plugin listens on the
   `tools/post-execute` waterfall. When a result exceeds a token budget and consists of
   text only, it keeps the head and tail on line boundaries, replaces the middle with a
   marker that states how much was dropped and how to get it back, and accepts the result
   with that content. The pruned content is what the session records, so every later
   request carries the smaller version — the saving compounds on its own.
2. **Hides tools you never use.** `hideTools` names tools that `ctx.tools.restrict()`
   removes from the global registry, so their JSON schemas are no longer sent with each
   request. Discovery, lookup, and execution stay aligned: a hidden tool reads as absent
   everywhere. Names that are not registered are ignored instead of failing the plugin.

It is complementary to billion-context (ACP): ACP folds long conversations at the
gateway, and this plugin keeps those folds smaller by producing smaller inputs in the
first place. It also complements the built-in spill of very large shell output to a
temporary file, which only covers one tool family.

## Install

The plugin is a Host-only bundle. It needs a Harness build that exposes the `tools`
service and the `tools/post-execute` waterfall; there is no UI contribution.

```text
# from this directory (or a packed dsh-token-saver-1.0.0.tgz)
plugin_manager install_bundle target=<absolute path to dsh-token-saver>
```

Installing wires the package into the profile, adds it to `dsh.profile.bundles`, and
applies `cordis.patch.yml`. To change settings afterwards, edit the inserted row's `config`
in the profile patch (or repack with a different default) — the defaults below apply when a
key is absent.

## Configuration

`cordis.patch.yml` inserts one row. Every key is optional and validated with clamps, so an
out-of-range value falls back or saturates instead of throwing.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the result pruning off while keeping the rest of the plugin. |
| `maxResultTokens` | `2000` | Budget for one tool result, in tokens (200–200000). |
| `headRatio` | `0.6` | Share of the kept budget taken from the start; the rest comes from the end (0.1–0.9). |
| `minSavedChars` | `200` | Do not prune when the saving would not pay for the marker. |
| `keepErrorResults` | `true` | Leave failed tool results untouched so failures stay diagnosable. |
| `skipTools` | `[]` | Tool names that must never be pruned. |
| `hideTools` | `[]` | Tool names removed from the registry for every agent. |
| `verbose` | `false` | Log mount state, hidden tools, and skipped results. |

```yaml
- insert:
    - id: dsh-token-saver
      name: dsh-token-saver
      config:
        maxResultTokens: 2000
        skipTools: ['read']
```

## What it deliberately does not do

- It never rewrites assistant or user messages, the system prompt, or another plugin's
  contributions. History stays the session log's job.
- It skips results containing images, files, or any non-text block, and skips results
  already re-rendered by another `post-execute` listener (`value` decisions).
- It does not compress conversations. That remains billion-context's role.

## Verifying it works

1. Install the bundle directory with `plugin_manager` (`install_bundle`), confirm a
   `dsh-token-saver` row is active.
2. Run a tool that returns a large text result (for example `read` on a long file without
   `limit`). The result should end with the `[... N of M characters kept ...]` marker, and
   the card should show the shortened text.
3. Omit the marker by setting `maxResultTokens` far above the output size; the result must
   come back unchanged, which shows the listener only acts above the budget.
4. Ask the agent to re-read the same region with `offset`/`limit` — the suggested recovery
   path must work, because `read` itself is untouched.

## Limits

- The token estimate is a local heuristic (wide characters ≈ 1 token, others ≈ 1 per 3.6
  characters), used only to size the cut and report it. Trimming is approximate by design.
- Pruning is applied per result, not per turn; a batch of many medium results each below
  the budget is left alone.
- `hideTools` applies to the whole profile, including subagents, and stays in effect until
  the row's config changes.
