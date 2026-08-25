import { writeFileSync } from 'node:fs'

// The package is ESM at the root, so Node would read every emitted `.js` as ESM,
// including the CommonJS build. A one-key package.json in each output folder
// pins the module kind for that folder and keeps both builds on plain `.js`.
const manifests = [
  ['dist/esm/package.json', { type: 'module' }],
  ['dist/cjs/package.json', { type: 'commonjs' }],
]

for (const [path, manifest] of manifests) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}
