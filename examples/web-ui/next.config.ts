import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"

const here = dirname(fileURLToPath(import.meta.url))

const config: NextConfig = {
  // fx-durable loads libfx's native addon and node:sqlite; load them from Node, not the bundle.
  devIndicators: false,
  serverExternalPackages: ["fx-durable", "libfx"],
  // fx-durable is linked from the repo root (link:../..).
  turbopack: { root: resolve(here, "../..") }
}

export default config
