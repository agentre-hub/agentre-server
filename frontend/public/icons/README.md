# PWA icons

These PNGs are generated from the shared package's brand tile — do not edit them by
hand. Rasterize from the repository root of `frontend/`:

```sh
SVG="node_modules/@agentre-hub/agentre-ui/src/engine/assets/images/logo-tile.svg"
```

## `any` purpose (plate keeps its own rounded corners, transparent margin)

The tile is a 1024×1024 canvas whose rounded plate spans `896/1024` of it. Render at
the target size directly so the transparent margin survives:

```sh
rsvg-convert -w 192 -h 192 "$SVG" -o public/icons/icon-192.png
rsvg-convert -w 512 -h 512 "$SVG" -o public/icons/icon-512.png
```

## `maskable` purpose + apple-touch-icon (full-bleed, opaque corners)

A maskable icon must fill its whole square: the platform crops it and transparent
corners would show as the manifest background (Android) or black (iOS). The plate's
rounded clip is therefore opened up to the full canvas first, then rendered at the
target size.

```sh
sed 's|x="64" y="64" width="896" height="896" rx="218"|x="0" y="0" width="1024" height="1024"|g' \
  "$SVG" > /tmp/logo-tile-fullbleed.svg

rsvg-convert -w 192 -h 192 /tmp/logo-tile-fullbleed.svg -o public/icons/maskable-192.png
rsvg-convert -w 512 -h 512 /tmp/logo-tile-fullbleed.svg -o public/icons/maskable-512.png
rsvg-convert -w 180 -h 180 /tmp/logo-tile-fullbleed.svg -o public/icons/apple-touch-icon-180.png
```

Verify the result before committing:

```sh
identify public/icons/*.png
convert public/icons/icon-192.png -format '%[pixel:p{0,0}]' info:        # srgba(...,0)
convert public/icons/maskable-192.png -format '%[pixel:p{0,0}]' info:    # srgb(...) — no alpha
```

The manifest that consumes these files is `public/manifest.webmanifest`; the install
contract test is `src/__tests__/pwa-install.test.ts`.
