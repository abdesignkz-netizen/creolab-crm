import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { GlobalFonts } from "@napi-rs/canvas";

// Synthetic scans must have real glyphs even on Linux without Arial or any
// matching system fallback. The OCR result itself is still produced normally.
export const testCanvasFont = "BasQar Scan Fixture";
assert.ok(GlobalFonts.registerFromPath(fileURLToPath(new URL("../../assets/fonts/NotoSans-Regular.ttf", import.meta.url)), testCanvasFont), "Bundled scan fixture font must load");
