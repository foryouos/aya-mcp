import { getDevicePlatform } from '../../adb/platform'
import { resolveDeviceId } from './device'

// Linux 工控主板（RK3568/RK3576 上的 Debian/Ubuntu/Buildroot/Yocto）只有
// adb 的 shell / sync / forward 通道，因此可用工具都是"不依赖 Android 命令"的那些。
// 未列出的工具一律按 Android 专属处理：在 Linux 设备上直接返回 NOT_SUPPORTED，
// 而不是让它们各自去执行 pm/am/uiautomator/screencap 后报 command not found。
const LINUX_TOOLS = new Set<string>([
  // 主机侧 / 不碰设备
  'aya_list_devices',
  'aya_stats',
  // 串口完全走主机串口，与设备平台无关
  'aya_serial_status',
  'aya_serial_logs',
  'aya_serial_wait',
  'aya_serial_list_ports',
  'aya_serial_open',
  'aya_serial_close',
  'aya_serial_write',
  'aya_serial_clear',
  'aya_serial_pause',
  'aya_serial_resume',
  'aya_serial_stages',
  // adb shell / sync / forward
  'aya_shell',
  'aya_list_dir',
  'aya_pull_file',
  'aya_push_file',
  'aya_delete_path',
  'aya_make_dir',
  'aya_rename_path',
  'aya_stat_path',
  'aya_list_ports',
  'aya_add_port',
  'aya_remove_port',
  'aya_list_processes',
  // 日志：Linux 上走 journalctl/dmesg，接口与 logcat 对齐
  'aya_logcat',
  'aya_logcat_wait',
  'aya_clear_logcat',
])

/**
 * 返回空串表示允许执行；否则是给调用方看的不支持原因。
 * 这里只关心"工具是否依赖 Android 专有能力"，不看具体参数。
 */
export async function getPlatformBlockReason(
  toolName: string,
  args: Record<string, unknown> | undefined
): Promise<string> {
  if (LINUX_TOOLS.has(toolName)) {
    return ''
  }

  let deviceId = ''
  try {
    deviceId = await resolveDeviceId(
      args && typeof args.deviceId === 'string' && args.deviceId
        ? args.deviceId
        : undefined
    )
  } catch {
    // 没有设备时交给工具自己报 NO_DEVICE，这里不抢错误
    return ''
  }

  try {
    const platform = await getDevicePlatform(deviceId)
    if (platform.platform === 'android') {
      return ''
    }

    return `${toolName} 依赖 Android 专有能力（uiautomator / input / pm / am / screencap / logcat），当前设备 ${
      platform.name || deviceId
    } 是 Linux（${platform.distro}），请改用 aya_shell、aya_list_dir、aya_push_file 等基础工具`
  } catch {
    return ''
  }
}
