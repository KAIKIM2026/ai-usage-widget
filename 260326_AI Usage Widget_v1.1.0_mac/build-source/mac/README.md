# Mac Build Notes

This folder contains the macOS packaging setup for `AI Usage Widget`.

## What is here

- `electron-builder.mac.json`: macOS-specific `electron-builder` config

## Commands

Run these commands on a real Mac:

```bash
npm install
npm run dist:mac
```

If you only want an unpacked app bundle for testing:

```bash
npm run pack:mac
```

## Output

Artifacts are written to:

```text
dist/mac
```

## Important

- Building a usable macOS app should be done on macOS.
- For a custom macOS app icon, add `mac/icon.icns` and then point the mac config to it.
- Unsigned builds may show a Gatekeeper warning on first launch.
