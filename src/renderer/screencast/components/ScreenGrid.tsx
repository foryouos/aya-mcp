import { observer } from 'mobx-react-lite'
import { CSSProperties } from 'react'
import store from '../store'
import ScreenTile from './ScreenTile'
import Style from './ScreenGrid.module.scss'

// 手机都是竖屏，优先横向铺开；4 路以上才换行
function getColumns(count: number) {
  if (count <= 1) {
    return 1
  }
  if (count <= 3) {
    return count
  }
  if (count === 4) {
    return 2
  }
  return 3
}

/**
 * 网格与聚焦共用同一棵 DOM 结构，只切换 grid 行列定义。
 * 如果分成两个分支渲染，切换布局时 React 会卸载重建整棵子树，
 * 视频元素被摘掉重新挂载，画面会闪黑甚至重新建立解码链路。
 */
export default observer(function ScreenGrid() {
  const { tiles, layout, focusDeviceId, activeDeviceId } = store

  if (!tiles.length) {
    return <div className={Style.grid}></div>
  }

  // 聚焦目标必须还在列表里，否则所有格子都会挤到第二列、第一列空着
  const focusId =
    layout === 'spotlight' &&
    tiles.length > 1 &&
    tiles.some((item) => item.device.id === focusDeviceId)
      ? focusDeviceId
      : ''
  const others = tiles.filter((item) => item.device.id !== focusId)
  const spotlight = !!focusId && others.length > 0

  const gridStyle: CSSProperties = spotlight
    ? {
        gridTemplateColumns: 'minmax(0, 1fr) minmax(120px, 22%)',
        gridTemplateRows: `repeat(${others.length}, minmax(0, 1fr))`,
      }
    : {
        gridTemplateColumns: `repeat(${getColumns(tiles.length)}, minmax(0, 1fr))`,
      }

  return (
    <div className={Style.grid} style={gridStyle}>
      {tiles.map((tile) => {
        const focused = tile.device.id === focusId
        const cellStyle: CSSProperties = !spotlight
          ? {}
          : focused
            ? { gridColumn: 1, gridRow: '1 / -1' }
            : { gridColumn: 2 }

        return (
          <div key={tile.device.id} className={Style.cell} style={cellStyle}>
            <ScreenTile
              tile={tile}
              focused={focused}
              active={tile.device.id === activeDeviceId}
            />
          </div>
        )
      })}
    </div>
  )
})
