import * as base from '../../adb/base'
import { resolveDeviceId } from '../lib/device'
import { jsonResult, McpError } from '../lib/result'
import { McpTool } from './types'

const deviceIdProperty = {
  type: 'string',
  description: '设备 id。省略时使用 AYA 当前选中设备',
}

// 所有适配类工具都遵循同一套流程：先读旧值 → 写新值 → 回读确认，
// 避免「命令返回成功但设备不支持」的情况被当成生效。
async function readShell(deviceId: string, command: string) {
  const value = await base
    .shell(deviceId, command)
    .then((out) => String(out).trim())
    .catch(() => '')

  return !value || value === 'null' ? null : value
}

function buildResult(
  deviceId: string,
  previous: string | null,
  current: string | null,
  expected: string,
  extra: Record<string, unknown> = {}
) {
  const applied = current !== null && current.includes(expected)

  return {
    deviceId,
    previous,
    current,
    applied,
    ...extra,
    hint: applied
      ? undefined
      : `命令已执行但读回值不一致（期望 ${expected}），设备可能不支持该设置或需要重启应用`,
  }
}

const setRotation: McpTool = {
  name: 'aya_set_rotation',
  description:
    '设置屏幕方向（关闭自动旋转并锁定）：0=0°、1=90°、2=180°、3=270°。auto:true 时改为恢复重力感应旋转。用于横竖屏适配验证。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      rotation: {
        type: 'number',
        description: '0/1/2/3，分别对应 0°/90°/180°/270°',
      },
      auto: {
        type: 'boolean',
        description: '恢复自动旋转（忽略 rotation）',
      },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const previousRotation = await readShell(
      deviceId,
      'settings get system user_rotation'
    )
    const previousAuto = await readShell(
      deviceId,
      'settings get system accelerometer_rotation'
    )

    if (args.auto === true) {
      await base.shell(deviceId, 'settings put system accelerometer_rotation 1')
      const currentAuto = await readShell(
        deviceId,
        'settings get system accelerometer_rotation'
      )
      return jsonResult({
        ok: true,
        ...buildResult(deviceId, previousAuto, currentAuto, '1', {
          auto: true,
          previousRotation,
        }),
      })
    }

    const rotation = Number(args.rotation)
    if (![0, 1, 2, 3].includes(rotation)) {
      throw new McpError(
        'INVALID_ARGS',
        'rotation 必须是 0/1/2/3（0°、90°、180°、270°）'
      )
    }

    await base.shell(deviceId, 'settings put system accelerometer_rotation 0')
    await base.shell(deviceId, `settings put system user_rotation ${rotation}`)
    const current = await readShell(deviceId, 'settings get system user_rotation')

    return jsonResult({
      ok: true,
      ...buildResult(deviceId, previousRotation, current, String(rotation), {
        auto: false,
        previousAuto,
        degrees: rotation * 90,
      }),
    })
  },
}

const setDensity: McpTool = {
  name: 'aya_set_density',
  description:
    '设置屏幕密度（wm density），用于验证不同 dpi 下的布局。reset:true 时恢复设备默认密度。返回 previous/current。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      density: {
        type: 'number',
        description: '目标 dpi，常用 160/240/320/420/480',
      },
      reset: { type: 'boolean', description: '恢复默认密度（忽略 density）' },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const previous = await readShell(deviceId, 'wm density')

    if (args.reset === true) {
      await base.shell(deviceId, 'wm density reset')
      const current = await readShell(deviceId, 'wm density')
      return jsonResult({
        ok: true,
        ...buildResult(deviceId, previous, current, 'reset', { reset: true }),
      })
    }

    const density = Math.floor(Number(args.density))
    if (!Number.isFinite(density) || density < 72 || density > 1000) {
      throw new McpError('INVALID_ARGS', 'density 需在 72 - 1000 之间')
    }

    await base.shell(deviceId, `wm density ${density}`)
    const current = await readShell(deviceId, 'wm density')

    return jsonResult({
      ok: true,
      ...buildResult(deviceId, previous, current, String(density)),
    })
  },
}

const setResolution: McpTool = {
  name: 'aya_set_resolution',
  description:
    '设置屏幕分辨率（wm size），如 1080x2400，用于验证小屏/大屏布局。reset:true 恢复物理分辨率。返回 previous/current。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      width: { type: 'number', description: '宽度像素' },
      height: { type: 'number', description: '高度像素' },
      reset: { type: 'boolean', description: '恢复默认分辨率' },
    },
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const previous = await readShell(deviceId, 'wm size')

    if (args.reset === true) {
      await base.shell(deviceId, 'wm size reset')
      const current = await readShell(deviceId, 'wm size')
      return jsonResult({
        ok: true,
        ...buildResult(deviceId, previous, current, 'reset', { reset: true }),
      })
    }

    const width = Math.floor(Number(args.width))
    const height = Math.floor(Number(args.height))
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 200 ||
      height < 200 ||
      width > 8000 ||
      height > 8000
    ) {
      throw new McpError(
        'INVALID_ARGS',
        'width/height 需在 200 - 8000 之间，例如 width:1080, height:2400'
      )
    }

    await base.shell(deviceId, `wm size ${width}x${height}`)
    const current = await readShell(deviceId, 'wm size')

    return jsonResult({
      ok: true,
      ...buildResult(deviceId, previous, current, `${width}x${height}`),
    })
  },
}

const setLocale: McpTool = {
  name: 'aya_set_locale',
  description:
    '设置系统语言列表（settings put system system_locales，如 "en-US,zh-CN"）。写入后多数应用需要重启进程才刷新文案，建议配合 aya_stop_app + aya_start_app。返回 previous/current。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      locales: {
        type: 'string',
        description: 'BCP-47 语言列表，逗号分隔，如 en-US 或 zh-CN,en-US',
      },
    },
    required: ['locales'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const locales = String(args.locales || '').trim()
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*(,[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)*$/.test(locales)) {
      throw new McpError(
        'INVALID_ARGS',
        `语言格式不合法：${locales || '(空)'}，应形如 en-US 或 zh-CN,en-US`
      )
    }

    const previous = await readShell(deviceId, 'settings get system system_locales')
    await base.shell(deviceId, `settings put system system_locales "${locales}"`)
    const current = await readShell(deviceId, 'settings get system system_locales')
    const result = buildResult(deviceId, previous, current, locales)

    return jsonResult({
      ok: true,
      ...result,
      hint: result.applied
        ? '已写入；重启应用进程（aya_stop_app + aya_start_app）后文案才会刷新'
        : result.hint,
    })
  },
}

const setDarkMode: McpTool = {
  name: 'aya_set_dark_mode',
  description:
    '切换深色/浅色模式（cmd uimode night yes/no/auto），用于深色适配验证。返回 previous/current。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      mode: {
        type: 'string',
        enum: ['yes', 'no', 'auto'],
        description: 'yes=深色，no=浅色，auto=跟随时间/系统',
      },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const mode = String(args.mode || '').toLowerCase()
    if (!['yes', 'no', 'auto'].includes(mode)) {
      throw new McpError('INVALID_ARGS', 'mode 必须是 yes / no / auto')
    }

    const previous = await readShell(deviceId, 'cmd uimode night')
    await base.shell(deviceId, `cmd uimode night ${mode}`)
    const current = await readShell(deviceId, 'cmd uimode night')

    return jsonResult({
      ok: true,
      ...buildResult(deviceId, previous, current, mode),
    })
  },
}

const setAnimationScale: McpTool = {
  name: 'aya_set_animation_scale',
  description:
    '设置动画缩放（window/transition/animator 三项全局设置），scale:0 可关闭动画让界面更快稳定，也常用于验证无动画场景。返回 previous/current。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
      scale: {
        type: 'number',
        description: '缩放倍数，0 关闭动画，1 为默认，范围 0 - 10',
      },
    },
    required: ['scale'],
    additionalProperties: false,
  },
  write: true,
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const scale = Math.round(Number(args.scale) * 10) / 10
    if (!Number.isFinite(scale) || scale < 0 || scale > 10) {
      throw new McpError('INVALID_ARGS', 'scale 需在 0 - 10 之间')
    }

    const keys = [
      'window_animation_scale',
      'transition_animation_scale',
      'animator_duration_scale',
    ]
    const previous: Record<string, string | null> = {}
    for (const key of keys) {
      previous[key] = await readShell(deviceId, `settings get global ${key}`)
      await base.shell(deviceId, `settings put global ${key} ${scale}`)
    }

    const current: Record<string, string | null> = {}
    for (const key of keys) {
      current[key] = await readShell(deviceId, `settings get global ${key}`)
    }

    const applied = keys.every((key) => current[key] === String(scale))

    return jsonResult({
      ok: true,
      deviceId,
      previous,
      current,
      scale: String(scale),
      applied,
      hint: applied
        ? scale === 0
          ? '动画已关闭：界面切换更快，等待类工具可以适当缩短超时'
          : undefined
        : '读回值不一致，可能被系统策略覆盖',
    })
  },
}

const listDisplays: McpTool = {
  name: 'aya_list_displays',
  description:
    '列出设备的逻辑显示屏（dumpsys display）：displayId、名称、分辨率、刷新率、旋转与状态。多屏/投屏/副屏场景下与 aya_screencap 的 displayId 配合使用。',
  inputSchema: {
    type: 'object',
    properties: {
      deviceId: deviceIdProperty,
    },
    additionalProperties: false,
  },
  write: false,
  annotations: { readOnlyHint: true },
  timeout: 30000,
  handler: async (args) => {
    const deviceId = await resolveDeviceId(args.deviceId)
    const output = await base.shell(
      deviceId,
      'dumpsys display | grep -E "DisplayDeviceInfo|mBaseDisplayInfo|mOverrideDisplayInfo"'
    )

    const displays: any[] = []
    const seen = new Set<string>()

    for (const line of String(output).split(/\r?\n/)) {
      const idMatch = line.match(/displayId\s+(\d+)/)
      if (!idMatch) {
        continue
      }
      const id = idMatch[1]
      if (seen.has(id)) {
        continue
      }
      seen.add(id)

      const sizeMatch = line.match(/(\d+)\s*x\s*(\d+)/)
      const rotationMatch = line.match(/rotation\s+(\d+)/)
      const fpsMatch = line.match(/([\d.]+)\s*fps/)
      const stateMatch = line.match(/state=(\w+)/)
      const nameMatch = line.match(/name\s+([^\s,]+)/)

      displays.push({
        displayId: Number(id),
        name: nameMatch ? nameMatch[1] : null,
        width: sizeMatch ? Number(sizeMatch[1]) : null,
        height: sizeMatch ? Number(sizeMatch[2]) : null,
        rotation: rotationMatch ? Number(rotationMatch[1]) : null,
        fps: fpsMatch ? Number(fpsMatch[1]) : null,
        state: stateMatch ? stateMatch[1] : null,
      })
    }

    return jsonResult({
      ok: true,
      deviceId,
      total: displays.length,
      displays,
      hint: displays.length
        ? '多屏时用 aya_screencap 的 displayId 指定要截取的屏幕'
        : '未解析到显示屏信息，设备可能不支持 dumpsys display 的该字段',
    })
  },
}

export default [
  setRotation,
  setDensity,
  setResolution,
  setLocale,
  setDarkMode,
  setAnimationScale,
  listDisplays,
]
