"use client"

// Переиспользуем стиль ModeSelect (.overlay/.option/...) — тот же приём, что
// и у RoomStatusBadge.tsx: отдельного стилевого файла под ещё один
// полноэкранный оверлей в том же визуальном языке заводить не нужно.
import styles from "./ModeSelect.module.scss"

interface PauseMenuProps {
  onContinue: () => void
  onRestart: () => void
  onExitToMenu: () => void
}

/**
 * Меню паузы — открывается кнопкой-паузой (PauseButton) или Escape (см.
 * Game.tsx). В co-op НЕ трогает партнёра: сама пауза (блокировка локального
 * управления) уже применена в Engine.setPaused до показа этого меню, тут
 * только сами действия.
 */
export default function PauseMenu({ onContinue, onRestart, onExitToMenu }: PauseMenuProps) {
  return (
    <div className={styles.overlay}>
      <h1 className={styles.title}>Пауза</h1>

      <div className={styles.options}>
        <button className={styles.option} onClick={onContinue}>
          <span className={styles.optionIcon}>▶️</span>
          <span className={styles.optionLabel}>Продовжити</span>
        </button>

        <button className={styles.option} onClick={onRestart}>
          <span className={styles.optionIcon}>🔄</span>
          <span className={styles.optionLabel}>Почати рівень заново</span>
        </button>

        <button className={styles.option} onClick={onExitToMenu}>
          <span className={styles.optionIcon}>🚪</span>
          <span className={styles.optionLabel}>Вийти у головне меню</span>
        </button>
      </div>
    </div>
  )
}
