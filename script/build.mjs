// 用 execSync 跑 npm 命令（走系统 shell 的 npm.cmd），避免 zx 在 Windows 上
// 把 shell 解析到 WSL/Git bash 导致构建起不来
import { execSync } from 'node:child_process'
import fs from 'fs-extra'

const run = (cmd) =>
  execSync(cmd, { stdio: 'inherit', env: process.env })

const pkg = await fs.readJson('package.json')
const electron = pkg.devDependencies.electron
delete pkg.devDependencies
pkg.devDependencies = {
  electron,
}
delete pkg.scripts
pkg.scripts = {
  start: 'electron main/index.js',
}
pkg.main = 'main/index.js'

run('npm run build:main')
run('npm run build:preload')
run('npm run build:renderer')

await fs.copy('script/mcp', 'resources/mcp')
await fs.copy('build', 'dist/build')
await fs.copy('resources', 'dist/resources')
process.chdir('dist')

await fs.writeJson('package.json', pkg, {
  spaces: 2,
})

run('npm i --production')
