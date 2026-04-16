# AI Usage Widget

Always-on-top desktop widget for checking Claude and Codex usage side by side.

## Run

```bash
npm install
npm start
```

## Features

- Claude usage cards for current session, weekly limit, and additional spend
- Codex usage cards for current limit and weekly limit
- Auto refresh every 30 seconds
- Manual refresh button
- Resize handle
- Always-on-top floating widget
- Single-instance launch behavior

## Notes

- Claude data is read from the logged-in Claude web session inside the widget
- Codex data is read from the local `~/.codex/sessions` logs
- If Claude login is required, use the login prompt shown in the widget

## Build

Windows installer:

```bash
npm run dist
```

macOS package scaffold:

```bash
npm run dist:mac
```

Mac-specific packaging notes live in:

```text
mac/
```

## Structure

```text
ai-usage-widget/
  mac/
  package.json
  assets/
  src/
    main.js
    preload.js
    widget.html
```
