const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
let checked = 0
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.data'].includes(entry.name)) continue
    const name = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(name)
    else if (/\.(js|cjs)$/.test(name)) {
      const result = spawnSync(process.execPath, ['--check', name], { encoding: 'utf8' })
      if (result.status !== 0) { process.stderr.write(result.stderr || 'Syntax check failed: ' + name); process.exitCode = 1 }
      checked++
    }
  }
}
walk(path.resolve(__dirname, '..'))
console.log(`Checked ${checked} JavaScript files`)
