// Ship the ambient libfx declarations (libfx publishes none) inside dist and
// point the emitted reference directives at the shipped copy instead of src/.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

mkdirSync("dist/types", { recursive: true })
copyFileSync("src/types/libfx.d.ts", "dist/types/libfx.d.ts")

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

for (const file of walk("dist").filter((path) => path.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8")
  const fixed = text.replace(/(\/\/\/ <reference path=")(?:\.\.\/)+src\/types\/libfx\.d\.ts"/g, (_match, start) => {
    const depth = file.split("/").length - 2
    return `${start}${"../".repeat(depth)}types/libfx.d.ts"`
  })
  if (fixed !== text) writeFileSync(file, fixed)
}
