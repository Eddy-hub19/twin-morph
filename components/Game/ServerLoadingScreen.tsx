"use client"

import styles from "./ModeSelect.module.scss"

interface ServerLoadingScreenProps {
  elapsedMs: number
  /** true — подключаемся к localhost (см. isLocalServerUrl): там нет
   * холодного старта, либо сервер уже запущен, либо его просто не подняли. */
  isLocal: boolean
}

/**
 * Полноэкранная загрузка на время подключения к co-op серверу. Отдельный
 * экран, а не просто текст в кнопке — прод-сервер задеплоен на бесплатном
 * плане Render и после простоя "засыпает", первое подключение может честно
 * занять секунд 30-60 (см. game/network/serverHealth.ts), поэтому важно явно
 * объяснить игроку, что это не зависшая игра, а именно долгий холодный старт.
 * В локальной разработке этот сценарий не имеет смысла (см. isLocal) —
 * там просто ждём чуть-чуть с другим текстом.
 */
export default function ServerLoadingScreen({ elapsedMs, isLocal }: ServerLoadingScreenProps) {
  const seconds = Math.floor(elapsedMs / 1000)
  const isColdStart = !isLocal && elapsedMs >= 4000

  const message = isColdStart
    ? "Сервер просыпается — бесплатный хостинг, обычно это занимает до минуты…"
    : isLocal
      ? "Подключаемся к локальному серверу…"
      : "Подключаемся к серверу…"

  return (
    <div className={styles.overlay}>
      <h1 className={styles.title}>Twin Morph</h1>
      <div className={styles.spinner} />
      <p className={styles.subtitle}>{message}</p>
      {isColdStart && <p className={styles.loadingSeconds}>{seconds}с</p>}
    </div>
  )
}
