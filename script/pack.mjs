import builder, { publish } from 'electron-builder'
import isMac from 'licia/isMac.js'
import isWindows from 'licia/isWindows.js'

cd('dist')

const pkg = await fs.readJson('package.json')

// --x64 / --arm64 / --ia32 指定打包架构（主要用于在 arm64 Mac 上额外打 x64）
const args = process.argv.slice(2)
const archArg = args.find((a) => a === '--x64' || a === '--arm64' || a === '--ia32')

const config = {
  appId: pkg.appId,
  directories: {
    output: `../release/${pkg.version}`,
  },
  files: ['main', 'preload', 'renderer', 'node_modules/**/*'],
  // serialport 原生绑定需要解包，否则 asar 内无法加载 .node
  asarUnpack: ['node_modules/@serialport/**'],
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  extraResources: [
    {
      from: 'resources',
      to: './',
      filter: ['**/*'],
    },
    // 托盘图标必须是独立文件：Windows 下 nativeImage 无法从 exe 提取图标
    { from: 'build/tray.png', to: 'tray.png' },
    { from: 'build/icon.ico', to: 'tray.ico' },
  ],
  nsis: {
    allowToChangeInstallationDirectory: true,
    oneClick: false,
    installerSidebar: 'build/installerSidebar.bmp',
  },
  win: {
    target: [
      {
        target: 'nsis',
      },
    ],
    artifactName: '${productName}-${version}-win-x64.${ext}',
  },
  mac: {
    electronLanguages: ['zh_CN', 'en'],
    target: [
      {
        target: 'dmg',
      },
    ],
    icon: 'build/icon.icns',
    artifactName: '${productName}-${version}-mac-${arch}.${ext}',
  },
  linux: {
    target: [
      {
        target: 'AppImage',
      },
    ],
    category: 'Development',
    artifactName: '${productName}-${version}-linux-x86_64.${ext}',
  },
  // 默认不发布到任何远程，避免误推到上游服务器；需要自动发布时设 AYA_PUBLISH=1
  // 发布到 GitHub Releases: https://github.com/foryouos/aya-mcp/releases
  publish: process.env.AYA_PUBLISH
    ? {
        provider: 'github',
        owner: 'foryouos',
        repo: 'aya-mcp',
      }
    : null,
}

if (isMac) {
  const args = process.argv.slice(2)
  const entitlements = {
    entitlements: 'build/entitlements.mas.plist',
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
  }
  if (args.includes('--mas-dev')) {
    config.mac.target = [
      {
        target: 'mas-dev',
      },
    ]
    config.masDev = {
      ...entitlements,
      provisioningProfile: 'build/mas-dev.provisionprofile',
    }
  } else if (args.includes('--mas')) {
    config.mac.target = [
      {
        target: 'mas',
      },
    ]
    config.mac.extendInfo = {
      LSMinimumSystemVersion: '12.0',
    }
    config.mas = {
      ...entitlements,
      provisioningProfile: 'build/mas.provisionprofile',
    }
  }
}

if (isWindows) {
  const args = process.argv.slice(2)
  if (args.includes('--appx')) {
    config.win.target = [
      {
        target: 'appx',
      },
    ]
    config.appx = {
      identityName: 'LiriLiri.AYAAndroidManager',
      publisher: 'CN=B8CA87F2-EAEA-4C05-B38C-AAA50D3CBA24',
      publisherDisplayName: 'surunzi',
      displayName: 'AYA Android Manager',
    }
  }
}

await builder.build({
  config,
  arch: archArg ? archArg.slice(2) : undefined,
})
