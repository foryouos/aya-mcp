#!/usr/bin/env python3
"""AYA MCP 与 uiautomator2 的同板对比基准（u2 侧）。

注意：aya 的常驻 UiAutomation 与 uiautomator2 的 UiAutomation 争抢同一个
无障碍连接槽位，两者不能同时持有设备端无障碍连接，因此基准必须轮流跑：
测 u2 之前要停掉 aya 设备端服务（adb shell pkill -f io.liriliri.aya.Server）。

用法：
    ANDROID_SERIAL=4a7de4f19facc740 python script/bench/bench_u2.py --out tmp-bench-u2.json
"""

import argparse
import json
import statistics
import subprocess
import time

import uiautomator2 as u2

SETTINGS = 'com.android.settings/.Settings'
SEARCH_BOX = (317, 56)
SAFE_CLICK = (5, 1050)          # 导航栏空白区，无副作用
SAFE_SWIPE = ((5, 1000), (5, 900))
# 用码点构造「搜索」，避免 Windows 下源码被按 GBK 解码导致选择器乱码
SEARCH_TEXT = ''.join(chr(c) for c in (0x641C, 0x7D22))


def timed(fn, times):
    samples = []
    size = 0
    for _ in range(times):
        started = time.perf_counter()
        out = fn()
        samples.append((time.perf_counter() - started) * 1000)
        if out is not None:
            size = len(out) if isinstance(out, (str, bytes)) else size
    return {
        'n': len(samples),
        'avgMs': round(statistics.mean(samples), 1),
        'p50Ms': round(statistics.median(samples), 1),
        'p95Ms': round(sorted(samples)[max(0, int(len(samples) * 0.95) - 1)], 1),
        'minMs': round(min(samples), 1),
        'maxMs': round(max(samples), 1),
        'bytes': size,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', default='4a7de4f19facc740')
    parser.add_argument('--dump', type=int, default=20)
    parser.add_argument('--click', type=int, default=20)
    parser.add_argument('--swipe', type=int, default=20)
    parser.add_argument('--text', type=int, default=10)
    parser.add_argument('--shot', type=int, default=10)
    parser.add_argument('--out', default='tmp-bench-u2.json')
    args = parser.parse_args()

    d = u2.connect(args.serial)
    subprocess.run(
        ['adb', '-s', args.serial, 'shell', f'am start -n {SETTINGS}'],
        capture_output=True,
    )
    time.sleep(1.5)

    result = {'impl': 'uiautomator2', 'serial': args.serial, 'device': d.info.get('productModel')}

    # 1. UI 层级
    result['dump'] = timed(d.dump_hierarchy, args.dump)

    # 2. 点击（无副作用坐标）
    result['click'] = timed(lambda: d.click(*SAFE_CLICK), args.click)

    # 3. 滑动
    result['swipe'] = timed(
        lambda: d.swipe(*SAFE_SWIPE[0], *SAFE_SWIPE[1], 0.3), args.swipe
    )

    # 4. 文本输入：先点开设置搜索框拿到焦点
    d.click(*SEARCH_BOX)
    time.sleep(1.0)
    result['text_send_keys'] = timed(
        lambda: d.send_keys('aya bench'), max(1, args.text // 2)
    )
    d.clear_text()
    time.sleep(0.3)
    result['text_set_text'] = timed(
        lambda: d(resourceId='android:id/search_src_text').set_text('aya bench'),
        max(1, args.text // 2),
    )

    # 5. 截图
    result['screenshot'] = timed(lambda: d.screenshot().tobytes(), args.shot)

    # 6. 「按文本定位并点击」：agent 最常用的一步
    # 先回到设置首页，保证有可按文本匹配的控件
    subprocess.run(
        ['adb', '-s', args.serial, 'shell', f'am start -n {SETTINGS}'],
        capture_output=True,
    )
    time.sleep(1.5)
    # 先进入搜索页：那里的 EditText 有稳定 id，便于做「按控件定位点击」的同口径对比
    d.click(*SEARCH_BOX)
    time.sleep(1.2)
    try:
        result['tapById'] = timed(
            lambda: d(resourceId='android:id/search_src_text').click(),
            10,
        )
    except Exception as exc:  # 文本匹配失败不影响其它指标
        result['tapById'] = {'error': str(exc)}

    # 中文文本选择器在 Windows 版 u2 上会因请求编码问题匹配不到（已知坑），
    # 这里保留一次尝试，用于记录该差异
    try:
        result['tapByTextCn'] = timed(lambda: d(text=SEARCH_TEXT).click(), 3)
    except Exception as exc:
        result['tapByTextCn'] = {'error': str(exc)}

    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
