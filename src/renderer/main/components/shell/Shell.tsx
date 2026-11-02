import { observer } from 'mobx-react-lite'
import LunaToolbar, { LunaToolbarSpace } from 'luna-toolbar/react'
import Term from './Term'
import LunaTab, { LunaTabItem } from 'luna-tab/react'
import { t } from 'common/util'
import ToolbarIcon from 'share/renderer/components/ToolbarIcon'
import store from '../../store'
import Style from './Shell.module.scss'
import className from 'licia/className'
import { useEffect, useRef, useState } from 'react'
import uuid from 'licia/uuid'
import map from 'licia/map'
import filter from 'licia/filter'
import LunaCommandPalette from 'luna-command-palette/react'
import find from 'licia/find'
import idxOf from 'licia/idxOf'
import truncate from 'licia/truncate'
import { Terminal } from '@xterm/xterm'

interface IShell {
  id: string
  name: string
  sessionId: string
  terminal?: Terminal
}

export default observer(function Shell() {
  const [shells, setShells] = useState<Array<IShell>>([])
  const [commandPaletteVisible, setCommandPaletteVisible] = useState(false)
  const [selectedShell, setSelectedShell] = useState<IShell>({
    id: '',
    name: '',
    sessionId: '',
  })
  const numRef = useRef(1)
  const { device } = store

  useEffect(() => add(), [])

  useEffect(() => {
    if (!commandPaletteVisible) {
      return
    }
    function onKeydown(e: KeyboardEvent) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
        return
      }
      setTimeout(() => {
        const active = document.querySelector('.luna-command-palette-active')
        if (active) {
          active.scrollIntoView({ block: 'nearest' })
        }
      }, 0)
    }
    document.addEventListener('keydown', onKeydown, true)
    return () => document.removeEventListener('keydown', onKeydown, true)
  }, [commandPaletteVisible])

  function add() {
    const id = uuid()
    const shell = {
      id,
      name: `${t('shell')} ${numRef.current++}`,
      sessionId: '',
    }
    setShells([...shells, shell])
    setSelectedShell(shell)
  }

  function close(id: string) {
    const closedShell = find(shells, (shell) => shell.id === id)
    let closedIdx = idxOf(shells, closedShell)
    const newShells = filter(shells, (shell) => shell.id !== id)
    setShells(newShells)

    if (closedShell === selectedShell) {
      if (closedIdx >= newShells.length) {
        closedIdx = newShells.length - 1
      }
      setSelectedShell(newShells[closedIdx])
    }
  }

  const tabItems = map(shells, (shell) => {
    return (
      <LunaTabItem
        key={shell.id}
        id={shell.id}
        title={shell.name}
        closable={true}
        selected={selectedShell.id === shell.id}
      />
    )
  })

  const terms = map(shells, (shell) => {
    return (
      <Term
        key={shell.id}
        onSessionIdChange={(id) => {
          shell.sessionId = id
        }}
        onCreate={(terminal) => {
          shell.terminal = terminal
        }}
        visible={selectedShell.id === shell.id && store.panel === 'shell'}
      />
    )
  })

  const commands = map(getCommands(), ([title, command]) => {
    return {
      title: `${title} (${truncate(command, 95 - title.length)})`,
      handler: () => {
        const { sessionId, terminal } = selectedShell
        main.writeShell(sessionId, command)
        // 回到最新输出位置：之后命令回显与输出都会继续跟随底部
        terminal?.scrollToBottom()
        setTimeout(() => {
          terminal?.focus()
        }, 500)
      },
    }
  })

  return (
    <div className="panel-with-toolbar">
      <div className={className('panel-toolbar', Style.toolbar)}>
        <LunaTab
          className={Style.tabs}
          height={31}
          onSelect={(id) => {
            const shell = find(shells, (shell) => shell.id === id)
            if (shell) {
              setSelectedShell(shell)
            }
          }}
          onClose={close}
        >
          {tabItems}
        </LunaTab>
        <LunaToolbar className={Style.control}>
          <ToolbarIcon
            icon="add"
            title={t('add')}
            onClick={add}
            disabled={!device}
          />
          <LunaToolbarSpace />
          <ToolbarIcon
            icon="list"
            title={t('shortcut')}
            onClick={() => setCommandPaletteVisible(true)}
            disabled={!device}
          />
        </LunaToolbar>
      </div>
      <div className="panel-body">
        {terms}
        <LunaCommandPalette
          placeholder={t('typeCmd')}
          visible={commandPaletteVisible}
          onClose={() => setCommandPaletteVisible(false)}
          commands={commands}
        />
      </div>
    </div>
  )
})

type ICommand = [title: string, command: string]

function getCommands() {
  const system: ICommand[] = [
    [t('reboot'), 'reboot\n'],
    [t('rebootRecovery'), 'reboot recovery\n'],
    [t('rebootBootloader'), 'reboot bootloader\n'],
    [t('rebootLoader'), 'reboot loader\n'],
    [t('memInfo'), 'dumpsys meminfo\n'],
    [t('batteryInfo'), 'dumpsys battery\n'],
    [t('cmdRoot'), 'su\n'],
    [t('cmdUser'), 'id\n'],
    [
      t('cmdPlatform'),
      'getprop ro.board.platform; getprop ro.product.model; getprop ro.build.version.release\n',
    ],
    [t('cmdDtbModel'), 'cat /proc/device-tree/model; echo\n'],
    [t('cmdCmdline'), 'cat /proc/cmdline\n'],
    [
      `${t('start')} shizuku`,
      'sh /sdcard/Android/data/moe.shizuku.privileged.api/start.sh\n',
    ],
  ]

  if (store.language === 'zh-CN') {
    system.push([
      '授权 GKD',
      'pm grant li.songe.gkd android.permission.WRITE_SECURE_SETTINGS; appops set li.songe.gkd ACCESS_RESTRICTED_SETTINGS allow\n',
    ])
  }

  const groups: Array<[string, ICommand[]]> = [
    [t('groupSystem'), system],
    [
      t('groupDisplay'),
      [
        [t('cmdScreenSize'), 'wm size\n'],
        [t('cmdScreenDensity'), 'wm density\n'],
        [t('cmdDisplayInfo'), 'dumpsys display\n'],
        [t('cmdSurfaceFlinger'), 'dumpsys SurfaceFlinger\n'],
        [
          t('cmdFramebuffer'),
          'cat /sys/class/graphics/fb0/virtual_size\n',
        ],
        [t('cmdDrmSummary'), 'cat /sys/kernel/debug/dri/0/summary\n'],
        [
          t('cmdBacklight'),
          'cat /sys/class/backlight/*/brightness\n',
        ],
      ],
    ],
    [
      t('groupAudio'),
      [
        [t('cmdAudioInfo'), 'dumpsys audio\n'],
        [t('cmdAudioFlinger'), 'dumpsys media.audio_flinger\n'],
        [t('cmdAudioPolicy'), 'dumpsys media.audio_policy\n'],
        [t('cmdSoundCards'), 'cat /proc/asound/cards\n'],
        [t('cmdPcmDevices'), 'cat /proc/asound/pcm\n'],
        [t('cmdTinyMix'), 'tinymix\n'],
      ],
    ],
    [
      t('groupGpio'),
      [
        [t('cmdGpioState'), 'cat /sys/kernel/debug/gpio\n'],
        [t('cmdGpioInfo'), 'gpioinfo\n'],
        [t('cmdGpioExport'), 'ls /sys/class/gpio\n'],
        [t('cmdGpioIrq'), 'cat /proc/interrupts | grep -i gpio\n'],
      ],
    ],
    [
      t('groupPerf'),
      [
        [
          t('cmdThermal'),
          'cat /sys/class/thermal/thermal_zone*/type /sys/class/thermal/thermal_zone*/temp\n',
        ],
        [
          t('cmdCpuFreq'),
          'cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq\n',
        ],
        [
          t('cmdClkSummary'),
          'cat /sys/kernel/debug/clk/clk_summary | head -n 60\n',
        ],
        [t('cmdTop'), 'top -n 1 -m 15\n'],
      ],
    ],
    [
      t('groupStorage'),
      [
        [t('cmdPartitions'), 'cat /proc/partitions\n'],
        [t('cmdBlockByName'), 'ls -l /dev/block/by-name\n'],
        [t('cmdDiskUsage'), 'df -h\n'],
      ],
    ],
    [
      t('groupDebug'),
      [
        [t('cmdLogcat'), 'logcat -d -t 200\n'],
        [t('cmdLogcatClear'), 'logcat -c\n'],
        [t('cmdDmesg'), 'dmesg | tail -n 100\n'],
        [t('cmdI2c'), 'ls /dev/i2c-*; i2cdetect -l\n'],
      ],
    ],
  ]

  const commands: ICommand[] = []

  for (const [group, items] of groups) {
    for (const [title, command] of items) {
      commands.push([`${group} · ${title}`, command])
    }
  }

  return commands
}
