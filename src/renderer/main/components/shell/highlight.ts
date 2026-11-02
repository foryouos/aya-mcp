const CSI = '\x1b['
const ESC_CHAR = '\x1b'
const RESET = `${CSI}0m`
const C_PROMPT = `${CSI}1;32m`
const C_KEY = `${CSI}36m`
const C_SEP = `${CSI}90m`
const C_PATH = `${CSI}34m`
const C_NUM = `${CSI}33m`
const C_HEX = `${CSI}35m`
const C_OK = `${CSI}32m`
const C_ERR = `${CSI}31m`

const PROMPT_RE = /^([\w.@-]+:\S*\s+[$#])(.*)$/

const KEY_VALUE_RE = /^(\s*)([A-Za-z_][\w ./[\]()#-]*?)(\s*[:=]\s*)(.*)$/

const URL_RE = /^[a-z]+:\/\//

// 路径 / 十六进制 / 分辨率 / 状态关键字 / 数字，按此顺序单次扫描，避免颜色码被再次匹配
const TOKEN_RE =
  /(\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]*)+)|(\b0x[0-9a-fA-F]+\b)|(\b\d{3,5}x\d{3,5}(?:p\d+)?\b)|\b(ACTIVE|ENABLED|enabled|active|true|ok|OK|success|PASS)\b|\b(DISABLED|INACTIVE|disabled|inactive|false|fail|failed|FAIL|error|ERROR|denied|not found|No such file or directory)\b|(\b\d[\d,]*(?:\.\d+)?[kKmMgG]?\b)/g

/**
 * 为 adb shell 的纯文本输出着色，模拟命令行的语法高亮。
 *
 * 只插入零宽的 SGR 控制序列，不改变字符的位置与宽度，因此不会影响换行与光标。
 * 已带有控制序列（ESC）、退格或行内回车的输出会原样透传，避免破坏 top / vi 等全屏程序。
 */
export function highlight(data: string) {
  if (data.indexOf(ESC_CHAR) !== -1) {
    return data
  }

  const lines = data.split('\n')
  const last = lines.length - 1
  let result = ''

  for (let i = 0; i <= last; i++) {
    const line = lines[i]

    // 结尾换行产生的空串，换行已在上一次循环写入
    if (i === last && line === '') {
      break
    }

    let text = line
    let cr = ''
    if (text.charCodeAt(text.length - 1) === 13) {
      text = text.slice(0, -1)
      cr = '\r'
    }

    if (
      text.trim() === '' ||
      text.indexOf('\r') !== -1 ||
      text.indexOf('\b') !== -1
    ) {
      result += text + cr + (i === last ? '' : '\n')
      continue
    }

    const colored = colorize(text)
    result +=
      (colored.endsWith(RESET) ? colored : colored + RESET) +
      cr +
      (i === last ? '' : '\n')
  }

  return result
}

function colorize(line: string) {
  const prompt = PROMPT_RE.exec(line)
  if (prompt) {
    return C_PROMPT + prompt[1] + RESET + colorizeValue(prompt[2])
  }

  const kv = KEY_VALUE_RE.exec(line)
  if (kv && !URL_RE.test(line.trim())) {
    return (
      kv[1] +
      C_KEY +
      kv[2] +
      RESET +
      C_SEP +
      kv[3] +
      RESET +
      colorizeValue(kv[4])
    )
  }

  return colorizeValue(line)
}

function colorizeValue(text: string) {
  if (!text) {
    return text
  }

  return text.replace(TOKEN_RE, (match, path, hex, res, ok, err, num) => {
    if (path) {
      return C_PATH + path + RESET
    }
    if (hex) {
      return C_HEX + hex + RESET
    }
    if (res) {
      return C_NUM + res + RESET
    }
    if (ok) {
      return C_OK + ok + RESET
    }
    if (err) {
      return C_ERR + err + RESET
    }
    if (num) {
      return C_NUM + num + RESET
    }
    return match
  })
}
