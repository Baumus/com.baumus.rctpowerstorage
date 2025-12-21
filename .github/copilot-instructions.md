# Copilot instructions

## Generated files

- Treat `.homeybuild/**` as generated build output.
- Do **not** open, read, search, or edit files under `.homeybuild/**`.
- If a change appears to be needed in `.homeybuild/**`, change the corresponding source file outside `.homeybuild/**` instead.

## Testing

- Jest should run only source tests under `test/**`.
- Do not modify Jest config to include `.homeybuild/**` tests unless the user explicitly asks.

## General

- Prefer minimal, targeted changes.
- Keep behavior changes covered by tests when practical.
