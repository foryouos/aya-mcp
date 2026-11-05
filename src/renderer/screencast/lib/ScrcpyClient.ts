import strHash from 'licia/strHash'
import toStr from 'licia/toStr'
import type { IServerLike } from 'share/preload/node'
import lpad from 'licia/lpad'
import Emitter from 'licia/Emitter'
import log from 'share/common/log'
import {
  ScrcpyOptions3_1,
  ScrcpyVideoCodecId,
  ScrcpyAudioCodec,
  ScrcpyControlMessageWriter,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  AndroidScreenPowerMode,
  AndroidKeyEventAction,
  AndroidKeyCode,
  ScrcpyMediaStreamDataPacket,
} from '@yume-chan/scrcpy'
import {
  InspectStream,
  WritableStream,
  ReadableStream,
  BufferedReadableStream,
  PushReadableStream,
  Consumable,
  ReadableWritablePair,
} from '@yume-chan/stream-extra'
import {
  WebCodecsVideoDecoder,
  InsertableStreamVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs'
import { Float32PcmPlayer } from '@yume-chan/pcm-player'
import { getUint32BigEndian } from '@yume-chan/no-data-view'
import Readiness from 'licia/Readiness'
import { OpusStream } from './AudioStream'
import sleep from 'licia/sleep'
import {
  isInsideVideoFrame,
  isSocketDestroyed,
  socketToReadableStream,
  socketToReadableWritablePair,
} from './util'
import clamp from 'licia/clamp'
import Recorder from './Recorder'
import convertBin from 'licia/convertBin'
import dateFormat from 'licia/dateFormat'
import noop from 'licia/noop'
import Keyboard from './Keyboard'
import isUndef from 'licia/isUndef'

const logger = log('ScrcpyClient')

/**
 * 「没有新帧」不能直接当成卡死：设备熄屏、界面静止、编码器暂停输出时
 * 都完全不出帧，而链路是好的。所以阈值放得很宽，并且只作为弱提示，
 * 真正的断线判断交给 socket close 与设备在线状态。
 */
const FRAME_STALL_TIMEOUT = 60 * 1000
// 请求关键帧后仍然没有画面，才认定为真的卡死
const FRAME_RECOVERY_TIMEOUT = 10 * 1000
const FRAME_WATCHDOG_INTERVAL = 5 * 1000

export default class ScrcpyClient extends Emitter {
  private deviceId: string
  private server?: IServerLike
  private video: any
  private audio: any
  private control: any
  private options: ScrcpyOptions3_1
  private readiness = new Readiness()
  private recorder = new Recorder()
  private keyboard = new Keyboard(this)
  // 已建立的对端连接必须显式关闭：server.close() 只是停止 accept，
  // 不会断开已有 socket，反复开关投屏会累积解码器与 fd
  private sockets: Set<any> = new Set()
  private player: any
  private destroyed = false
  private lastFrameAt = 0
  private watchdogTimer: NodeJS.Timeout | null = null
  private stalledNotified = false
  // 首次发现无帧、已请求关键帧的时间点，0 表示当前不需要自救
  private stallRecoveryAt = 0
  // 会话级失败原因，供界面挂载时同步读取（事件可能在挂载前就发出了）
  failed: Error | null = null
  // 浏览器支持 video.requestVideoFrameCallback 时，帧时间由它提供
  private useFrameCallback = false
  /**
   * 多设备同屏时只有聚焦那一路出声音。
   * PcmPlayer 的 stop() 会关闭 AudioContext 且不可重入（之后再 start 无效、
   * feed 还会抛错），所以不能靠 stop/start 静音，只能丢弃音频包。
   */
  private audioEnabled = true
  constructor(deviceId: string, options: ScrcpyOptions3_1, audioEnabled = true) {
    super()

    this.options = options
    options.value.scid = toStr(strHash(deviceId) % 999999)
    this.deviceId = deviceId
    this.audioEnabled = audioEnabled

    this.start()
  }
  setAudioEnabled(enabled: boolean) {
    this.audioEnabled = enabled
  }
  /**
   * 主动熄屏后设备端编码器不再产出画面，这是预期行为。
   * 这里把停滞看门狗停掉，避免熄屏时被误判成链路卡死。
   */
  setScreenOff(off: boolean) {
    if (off) {
      this.stopFrameWatchdog()
      this.stalledNotified = false
      this.stallRecoveryAt = 0
    } else if (!this.watchdogTimer && this.video) {
      this.startFrameWatchdog()
    }
  }
  async getVideo() {
    this.ensureAlive()
    await this.readiness.ready('video')
    this.ensureAlive()
    return this.video
  }
  async getControl() {
    this.ensureAlive()
    await this.readiness.ready('control')
    return this.control
  }
  destroy() {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    logger.info('destroy')

    this.sockets.forEach((socket) => {
      try {
        if (typeof socket.destroy === 'function') {
          socket.destroy()
        }
      } catch {
        // ignore
      }
    })
    this.sockets.clear()

    if (this.server) {
      this.server.close()
      this.server = undefined
    }

    try {
      this.video?.decoder?.close?.()
    } catch {
      // ignore
    }
    try {
      this.player?.stop?.()
    } catch {
      // ignore
    }
    this.stopFrameWatchdog()

    // 通知主进程关闭设备端 scrcpy 进程与它的 adb shell 通道
    main.stopScrcpy(this.deviceId).catch(noop)
  }
  private ensureAlive() {
    if (this.destroyed) {
      throw new Error('scrcpy client destroyed')
    }
  }
  startRecording() {
    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.resetVideo().catch(noop)
    }
    this.recorder.start()
  }
  async stopRecording() {
    const buf = this.recorder.stop()
    if (buf) {
      const { canceled, filePath } = await main.showSaveDialog({
        defaultPath: `recording-${dateFormat('yyyymmddHHMM')}.mkv`,
      })
      if (canceled) {
        return
      }
      await node.writeFile(filePath, convertBin(buf, 'Uint8Array'))
    }
  }
  async turnOffScreen() {
    await this.readiness.ready('control')
    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.setScreenPowerMode(AndroidScreenPowerMode.Off).catch(noop)
    }
  }
  async turnOnScreen() {
    await this.readiness.ready('control')
    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.setScreenPowerMode(AndroidScreenPowerMode.Normal).catch(noop)
    }
  }
  async setClipboard(text: string, paste = false) {
    await this.readiness.ready('control')
    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller
        .setClipboard({
          sequence: 0n,
          content: text,
          paste,
        })
        .catch(noop)
    }
  }
  /**
   * 会话失败时立刻上报，而不是让界面干等 20 秒首帧超时。
   * 设备已掉线、端口占用、scrcpy 起不来都会走到这里。
   */
  private fail(err: unknown) {
    if (this.destroyed) {
      return
    }
    const error = err instanceof Error ? err : new Error(String(err))
    logger.warn('session failed', error.message)
    this.failed = error
    this.emit('error', error)
  }
  private start = async () => {
    const { deviceId, options } = this

    let port: number
    try {
      port = await main.reverseTcp(
        this.deviceId,
        `localabstract:scrcpy_${lpad(options.value.scid as string, 8, '0')}`
      )
    } catch (err) {
      this.fail(err)
      return
    }
    // reverseTcp 期间窗口可能已经被关掉
    if (this.destroyed) {
      return
    }

    const server = node.createServer(async (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      if (this.destroyed) {
        socket.destroy()
        return
      }

      // video socket is the first connection
      if (!this.video) {
        this.video = {}
        this.createVideo(socketToReadableStream(socket)).catch((err) => {
          logger.warn('create video failed', err)
          if (!this.destroyed) {
            this.emit('error', err)
          }
        })
        socket.on('close', () => {
          if (!this.destroyed) {
            this.emit('close')
          }
        })
        return
      }

      // audio socket and control socket orders are not guaranteed, need to detect
      let isAudio = false
      this.detectAudioStream(socketToReadableStream(socket))
        .then((value) => {
          // never resolve if it's control socket
          if (value.audio) {
            isAudio = true
            this.createAudio(value.stream).catch(noop)
          }
        })
        .catch(noop)
      sleep(1000).then(() => {
        // socket 可能已经断开，此时再建 control 通道只会得到一条永不结束的流
        if (!isAudio && !this.destroyed && !isSocketDestroyed(socket)) {
          this.createControl(socketToReadableWritablePair(socket)).catch(noop)
        }
      })
    })
    // 端口占用等 listen 失败必须即时抛出，否则窗口会一直停在加载中。
    // 旧版 preload 的壳没有 on 方法，这里做个兼容，别让整个启动流程中断
    if (typeof server.on === 'function') {
      server.on('error', (err) => {
        this.fail(err)
      })
    }
    server.listen(port)
    this.server = server

    main.startScrcpy(deviceId, options.serialize()).catch((err) => {
      this.fail(err)
    })
  }
  private async detectAudioStream(stream: ReadableStream<Uint8Array>) {
    let isAudio = false

    const buffered = new BufferedReadableStream(stream)
    const buffer = await buffered.readExactly(4)
    const codecMetadataValue = getUint32BigEndian(buffer, 0)

    const readableStream = new PushReadableStream<Uint8Array>(
      async (controller) => {
        try {
          await controller.enqueue(buffer)

          const stream = buffered.release()
          const reader = stream.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }
            await controller.enqueue(value)
          }
        } catch {
          // 下游已取消（会话销毁 / 该路音频被丢弃）时停止泵送即可
        }
      }
    )
    switch (codecMetadataValue) {
      case 0x00_00_00_00:
      case ScrcpyAudioCodec.Opus.metadataValue:
        isAudio = true
        break
    }

    if (isAudio) {
      return {
        audio: true,
        stream: readableStream,
      }
    }

    return {
      audio: false,
      stream: readableStream,
    }
  }
  private async createVideo(videoStream: ReadableStream<Uint8Array>) {
    logger.info('video stream connected')

    const { options } = this

    const { stream, metadata } = await options.parseVideoStreamMetadata(
      videoStream
    )

    logger.info('video metadata', metadata)
    this.recorder.videoMetadata = metadata

    let codec: any = 0
    switch (metadata.codec) {
      case ScrcpyVideoCodecId.H264:
        codec = ScrcpyVideoCodecId.H264
        break
    }
    const renderer = new InsertableStreamVideoFrameRenderer()
    const decoder = new WebCodecsVideoDecoder({
      codec,
      renderer,
    })

    this.video = {
      stream: stream
        .pipeThrough(options.createMediaStreamTransformer())
        .pipeThrough(
          new InspectStream((packet) => {
            this.recorder.addVideoPacket(packet)
            if (packet.type === 'configuration') {
              logger.info('video configuration', packet.data)
            } else if (!this.useFrameCallback) {
              // 没有 requestVideoFrameCallback 时退回按 packet 计时
              this.lastFrameAt = Date.now()
            }
          })
        ),
      metadata,
      decoder,
    }

    // 流只能被 pipe 一次，所以消费必须绑定在会话上而不是界面上。
    // 放在组件里做的话，界面一旦重新挂载（例如切换布局）就会重复 pipeTo，
    // 抛 "Cannot pipe a locked stream" 并让画面变成错误页
    this.video.stream.pipeTo(decoder.writable).catch((err: unknown) => {
      logger.warn('video pipe error', err)
      if (!this.destroyed) {
        this.emit('error', err)
      }
    })

    this.bindVideoEvent(renderer.element)

    logger.info('video ready')
    this.readiness.signal('video')
    this.startFrameWatchdog()
  }
  /**
   * 画面长时间不刷新时先试着自救，再决定要不要提示。
   *
   * 关键：scrcpy 的 H.264 编码器在设备画面静止时不会输出新帧，
   * 所以「一段时间没有新帧」是正常状态（停在输入法、桌面不动都会这样），
   * 直接报「画面已停止更新」是误判。
   *
   * 现在的判断是：无帧超过阈值 → 主动向编码器请求一个关键帧 →
   * 能出帧说明链路正常，静默恢复；请求后仍无帧才认为真的卡死。
   */
  private startFrameWatchdog() {
    this.stopFrameWatchdog()
    this.lastFrameAt = Date.now()
    this.stalledNotified = false
    this.stallRecoveryAt = 0
    this.watchdogTimer = setInterval(() => {
      if (this.destroyed) {
        this.stopFrameWatchdog()
        return
      }
      const idle = Date.now() - this.lastFrameAt
      if (idle <= FRAME_STALL_TIMEOUT) {
        this.stallRecoveryAt = 0
        if (this.stalledNotified) {
          this.stalledNotified = false
          logger.info('video recovered')
          this.emit('recovered')
        }
        return
      }

      if (!this.stallRecoveryAt) {
        this.stallRecoveryAt = Date.now()
        this.requestKeyFrame()
        return
      }

      if (Date.now() - this.stallRecoveryAt < FRAME_RECOVERY_TIMEOUT) {
        return
      }

      if (!this.stalledNotified) {
        this.stalledNotified = true
        logger.warn('video stalled', idle)
        this.emit('stalled')
      }
    }, FRAME_WATCHDOG_INTERVAL)
  }
  /** 让设备端编码器立刻产出一个关键帧，用于确认链路是否还活着 */
  private requestKeyFrame() {
    if (!this.control) {
      return
    }
    try {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller.resetVideo().catch(noop)
      logger.info('request key frame')
    } catch {
      // control 通道可能刚好断开，下一轮看门狗会继续尝试
    }
  }
  private stopFrameWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }
  private bindVideoEvent(el: HTMLVideoElement) {
    logger.info('bind video event')

    // 以「真正渲染出一帧」为基准，而不是 packet 到达。
    // 解码器背压时上游会暂停读取，但视频元素仍在播放已解码的帧，
    // 只按 packet 计时会把正常播放误判成画面卡死。
    const anyEl = el as any
    if (typeof anyEl.requestVideoFrameCallback === 'function') {
      this.useFrameCallback = true
      const onFrame = () => {
        this.lastFrameAt = Date.now()
        if (!this.destroyed) {
          anyEl.requestVideoFrameCallback(onFrame)
        }
      }
      anyEl.requestVideoFrameCallback(onFrame)
    }

    el.addEventListener('pointerdown', (e) => {
      el.focus()
      if (e.button === 0) {
        this.injectTouch(el, e)
      } else {
        this.injectKeyCode(el, e)
      }
    })
    el.addEventListener('pointermove', (e) => this.injectTouch(el, e))
    el.addEventListener('pointerup', (e) => {
      if (e.button === 0) {
        this.injectTouch(el, e)
      } else {
        this.injectKeyCode(el, e)
      }
    })

    el.addEventListener('wheel', (e) => this.injectScroll(el, e))

    el.setAttribute('tabindex', '0')
    el.addEventListener('keydown', this.keyboard.down)
    el.addEventListener('keyup', this.keyboard.up)
  }
  private injectKeyCode(el: HTMLVideoElement, e: PointerEvent) {
    // 黑边不参与注入：双击黑边用于放大该路，误注入会点坏设备
    if (
      e.type === 'pointerdown' &&
      !isInsideVideoFrame(el, e.clientX, e.clientY)
    ) {
      return
    }

    e.preventDefault()
    e.stopPropagation()

    const actionMap = {
      pointerdown: AndroidKeyEventAction.Down,
      pointerup: AndroidKeyEventAction.Up,
    }
    const action = actionMap[e.type]
    if (isUndef(action)) {
      return
    }

    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller
        .injectKeyCode({
          action,
          keyCode: MouseEventButtonToAndroidButton[e.button - 1],
          repeat: 0,
          metaState: 0,
        })
        .catch(noop)
    }
  }
  private injectScroll(el: HTMLVideoElement, e: WheelEvent) {
    if (!isInsideVideoFrame(el, e.clientX, e.clientY)) {
      return
    }

    e.preventDefault()
    e.stopPropagation()

    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller
        .injectScroll({
          ...this.getPointer(el, e.clientX, e.clientY),
          scrollX: -e.deltaX / 100,
          scrollY: -e.deltaY / 100,
          buttons: 0,
        })
        .catch(noop)
    }
  }
  private getPointer(el: HTMLVideoElement, clientX: number, clientY: number) {
    const screenWidth = el.width
    const screenHeight = el.height

    const rect = el.getBoundingClientRect()

    const videoRect = {
      width: 0,
      height: 0,
      x: 0,
      y: 0,
    }
    if (screenWidth / screenHeight < rect.width / rect.height) {
      videoRect.height = rect.height
      videoRect.width = videoRect.height * (screenWidth / screenHeight)
      videoRect.x = rect.x + (rect.width - videoRect.width) / 2
      videoRect.y = rect.y
    } else {
      videoRect.width = rect.width
      videoRect.height = videoRect.width * (screenHeight / screenWidth)
      videoRect.x = rect.x
      videoRect.y = rect.y + (rect.height - videoRect.height) / 2
    }

    const percentageX = clamp((clientX - videoRect.x) / videoRect.width, 0, 1)
    const percentageY = clamp((clientY - videoRect.y) / videoRect.height, 0, 1)

    const pointerX = percentageX * screenWidth
    const pointerY = percentageY * screenHeight

    return {
      screenWidth,
      screenHeight,
      pointerX,
      pointerY,
    }
  }
  private injectTouch(el: HTMLVideoElement, e: PointerEvent) {
    // 只在按下时判断是否在画面内。move/up 必须放行，
    // 否则手指从画面滑到黑边会让设备端一直卡在按下状态
    if (
      e.type === 'pointerdown' &&
      !isInsideVideoFrame(el, e.clientX, e.clientY)
    ) {
      return
    }

    e.preventDefault()
    e.stopPropagation()

    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)

    const { type, clientX, clientY, button, buttons } = e

    let action: AndroidMotionEventAction
    switch (type) {
      case 'pointerdown':
        action = AndroidMotionEventAction.Down
        break
      case 'pointermove':
        if (buttons === 0) {
          action = AndroidMotionEventAction.HoverMove
        } else {
          action = AndroidMotionEventAction.Move
        }
        break
      case 'pointerup':
        action = AndroidMotionEventAction.Up
        break
      default:
        throw new Error(`Unsupported event type: ${type}`)
    }

    if (this.control) {
      const controller: ScrcpyControlMessageWriter = this.control.controller
      controller
        .injectTouch({
          action,
          pointerId: BigInt(e.pointerId),
          ...this.getPointer(el, clientX, clientY),
          pressure: buttons === 0 ? 0 : 1,
          actionButton: PointerEventButtonToAndroidButton[button],
          buttons,
        })
        .catch(noop)
    }
  }
  private async createAudio(audioStream: ReadableStream<Uint8Array>) {
    logger.info('audio stream connected')

    const { options } = this

    const metadata = await options.parseAudioStreamMetadata(audioStream)

    logger.info('audio metadata', metadata)

    if (metadata.type !== 'success') {
      this.audio = metadata
    } else {
      this.audio = {
        ...metadata,
        stream: metadata.stream.pipeThrough(
          options.createMediaStreamTransformer()
        ),
      }

      const [recordStream, playbackStream] = this.audio.stream.tee()

      let player: any
      if (metadata.codec === ScrcpyAudioCodec.Raw) {
        logger.info('audio codec raw')
      } else if (metadata.codec === ScrcpyAudioCodec.Opus) {
        logger.info('audio codec opus')
        player = new Float32PcmPlayer(48000, 2)
        this.player = player
        playbackStream
          .pipeThrough(
            new OpusStream({
              codec: metadata.codec.webCodecId,
              numberOfChannels: 2,
              sampleRate: 48000,
            })
          )
          .pipeTo(
            new WritableStream({
              write: (chunk) => {
                // 非聚焦设备直接丢弃音频包，播放器保持运行以便随时切回
                if (!this.audioEnabled) {
                  return
                }
                try {
                  player.feed(chunk)
                } catch {
                  // 会话销毁时 AudioContext 已关闭，停止喂数据即可
                }
              },
            })
          )
          .catch(noop)

        player.start().catch(noop)
      }

      this.recorder.audioCodec = metadata.codec

      recordStream
        .pipeTo(
          new WritableStream({
            write: (packet: ScrcpyMediaStreamDataPacket) => {
              if (packet.type === 'data') {
                this.recorder.addAudioPacket(packet)
              }
            },
          })
        )
        .catch(noop)
    }

    logger.info('audio ready')
    this.readiness.signal('audio')
  }
  private async createControl(
    controlStream: ReadableWritablePair<Uint8Array, Consumable<Uint8Array>>
  ) {
    logger.info('control stream connected')

    const { options } = this

    const controller = new ScrcpyControlMessageWriter(
      controlStream.writable.getWriter(),
      options
    )

    options
      .clipboard!.pipeTo(
        new WritableStream({
          write: (content) => {
            navigator.clipboard.writeText(content)
          },
        })
      )
      .catch(noop)
    this.parseDeviceMessages(controlStream.readable).catch(noop)

    this.control = {
      controller,
    }

    logger.info('control ready')
    this.readiness.signal('control')
  }
  private async parseDeviceMessages(controlStream: ReadableStream<Uint8Array>) {
    const buffered = new BufferedReadableStream(controlStream)
    try {
      while (true) {
        let type: number
        try {
          const result = await buffered.readExactly(1)
          type = result[0]!
        } catch {
          this.options.endDeviceMessageStream()
          break
        }
        await this.options.parseDeviceMessage(type, buffered)
      }
    } catch (e) {
      this.options.endDeviceMessageStream(e)
      buffered.cancel(e).catch(() => {})
    }
  }
}

const PointerEventButtonToAndroidButton = [
  AndroidMotionEventButton.Primary,
  AndroidMotionEventButton.Tertiary,
  AndroidMotionEventButton.Secondary,
  AndroidMotionEventButton.Back,
  AndroidMotionEventButton.Forward,
]

const MouseEventButtonToAndroidButton = [
  AndroidKeyCode.AndroidHome,
  AndroidKeyCode.AndroidBack,
]
