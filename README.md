# RE1 PS1 Model Viewer Prototype

This is the first working slice of a browser-based Resident Evil 1 PS1 model viewer.

## What works now

- WebGL viewport with orbit, zoom, reset, wireframe, and simple animation toggles.
- A segmented low-poly placeholder model so the renderer is proven before RE-specific parsing.
- File drop/picker that recognizes `.EMD`, `.TIM`, and disc image candidates.
- First-pass `.EMD` mesh loading for untextured triangle models.
- A basic PSX `.TIM` header detector.
- Basic ISO9660 sniffing for 2048-byte ISO images and 2352-byte raw BIN images.

## What comes next

1. Improve EMD primitive support if we find quads or variant packet types.
2. Add extraction from the BIN directly in the browser.
3. Add texture upload from embedded `.TIM` data.
4. Add skeleton pose and animation playback.

## Learning Notes

The viewer and parser are deliberately separate. The viewer only needs vertices, triangle indices,
colors, and later texture coordinates. The parser's job is to translate RE1/PS1 binary data into
that simple shape.

Run it from a local server:

```powershell
cd re1-model-viewer-prototype
node server.js
```
