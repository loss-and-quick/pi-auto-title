# pi-auto-title

Pi package that automatically generates a session title after the first real prompt.

It uses this strategy:

1. **Primary:** hidden in-process model call via `@earendil-works/pi-ai` `complete()`.
2. **Model fallback:** if the primary title model fails, try configured fallback title models in order.
3. **Worst case only:** generate a synthetic fallback title.

This keeps title generation out of the main conversation while avoiding session replacement tricks.

## What it does

- waits for the first real prompt in a session
- generates a concise session title
- calls `pi.setSessionName(...)` automatically
- persists the generated title in session history via `pi.appendEntry(...)`
- never writes title-generation prompts into your main conversation
- exposes `/auto-title` for status and manual control

## Install

### Quick test

```bash
pi -e pi-auto-title/extensions/auto-title/index.ts
```

### Install as a local Pi package

```bash
pi install pi-auto-title
```

### Install project-local

```bash
pi install -l pi-auto-title
```

## Command

```text
/auto-title
/auto-title status
/auto-title regenerate
/auto-title fallback
/auto-title set <title>
```

## Configuration

Config is read from these paths, later entries overriding earlier ones:

1. bundled/default extension config: `extensions/auto-title/config.json`
2. global Pi config: `~/.pi/agent/extensions/auto-title/config.json`
3. project config: `.pi/extensions/auto-title/config.json`

If `PI_CODING_AGENT_DIR` is set, the global path is resolved under that directory instead of `~/.pi/agent`.

Example config:

```json
{
  "enabled": true,
  "model": "current",
  "fallbackModels": [],
  "maxChars": 60
}
```

Example with explicit model fallback:

```json
{
  "enabled": true,
  "model": "anthropic/claude-sonnet-4-5",
  "fallbackModels": ["openai/gpt-5-mini", "current"],
  "maxChars": 60
}
```

Field semantics:

- `enabled`: turn auto-title on/off
- `model`: `"current"`, `"provider/model"`, `false`, or `null`
- `fallbackModels`: ordered model fallback chain
- `maxChars`: title length cap

## Notes

- Primary title generation uses a hidden in-process model call, based on the same pattern shown in Pi's `qna.ts` and `summarize.ts` extension examples.
- `ctx.fork()` / `ctx.newSession()` are intentionally **not** used: in Pi extensions they replace the active session, which is the wrong behavior for hidden title generation.
- If a session already has a title, the extension leaves it alone.
- The synthetic fallback is used only after all configured model attempts fail, or when LLM title generation is disabled in config.
- The worst-case synthetic fallback format is `New Session YYYY-MM-DD`.
