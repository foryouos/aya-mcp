import Style from './App.module.scss'
import icon from '../../../renderer/assets/icon.png'
import { t } from '../../common/i18n'

export default function App() {
  return (
    <div className={Style.container}>
      <img className={Style.icon} src={icon} />
      <div className={Style.name}>{PRODUCT_NAME}</div>
      <div className={Style.version}>
        {t('version')} v{VERSION}
      </div>
      <button className={Style.button} onClick={() => main.showUpdateWindow()}>
        {t('checkUpdate')}
      </button>
    </div>
  )
}
