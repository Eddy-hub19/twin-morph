"use client"

import styles from "./PauseButton.module.scss"

interface PauseButtonProps {
  onClick: () => void
}

/** Кнопка-пауза поверх игры — постоянно видна во время игры (и в solo, и в
 * co-op), открывает PauseMenu. Расположение/z-index подобраны так, чтобы не
 * перекрывать ни RoomStatusBadge (верх-по-центру), ни сенсорный джойстик
 * (низ-право) — см. PauseButton.module.scss. */
export default function PauseButton({ onClick }: PauseButtonProps) {
  return (
    <button type="button" className={styles.button} onClick={onClick} aria-label="Пауза">
      ⏸
    </button>
  )
}
