"use client"

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import type { InputManager } from "@/game/input/InputManager"
import { JOYSTICK_MAX_STICK_OFFSET, JOYSTICK_DEADZONE } from "@/game/config/GameConfig"

import styles from "./TouchControls.module.scss"

// Насколько далеко можно оттянуть стик от центра базы, в пикселях — эта же
// дистанция считается "полным отклонением" (длина аналогового вектора = 1).
const MAX_STICK_OFFSET = JOYSTICK_MAX_STICK_OFFSET

// Стик реагирует только после того, как палец отошёл от центра дальше этого
// расстояния — иначе лёгкое дрожание пальца на месте постоянно слало бы
// шумный почти-нулевой вектор.
const DEADZONE = JOYSTICK_DEADZONE

interface TouchControlsProps {
  input: InputManager | null
}

/**
 * Сенсорный джойстик для мобильных экранов и планшетов: круглая база со
 * стрелками сторон и стик, который тянется пальцем от центра. В отличие от
 * WASD на клавиатуре (только 4 направления), тут червяк должен ходить под
 * любым углом (360°) — поэтому вместо снапа к ближайшей из 4 сторон стик
 * шлёт в InputManager непрерывный аналоговый вектор (x/y в [-1, 1], длина —
 * это сила отклонения), который Worm/Ant читают напрямую, а не как WASD.
 */
export default function TouchControls({ input }: TouchControlsProps) {
  const baseRef = useRef<HTMLDivElement>(null)
  const centerRef = useRef({ x: 0, y: 0 })
  const activePointerId = useRef<number | null>(null)

  const [stickOffset, setStickOffset] = useState({ x: 0, y: 0 })

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      let dx = clientX - centerRef.current.x
      let dy = clientY - centerRef.current.y
      const dist = Math.hypot(dx, dy)

      if (dist > MAX_STICK_OFFSET) {
        dx = (dx / dist) * MAX_STICK_OFFSET
        dy = (dy / dist) * MAX_STICK_OFFSET
      }

      setStickOffset({ x: dx, y: dy })

      if (dist < DEADZONE) {
        input?.clearAnalogVector()
        return
      }

      input?.setAnalogVector(dx / MAX_STICK_OFFSET, dy / MAX_STICK_OFFSET)
    },
    [input],
  )

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()

      const base = baseRef.current
      if (!base) return

      const rect = base.getBoundingClientRect()
      centerRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }

      activePointerId.current = e.pointerId
      base.setPointerCapture(e.pointerId)

      updateFromPointer(e.clientX, e.clientY)
    },
    [updateFromPointer],
  )

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (activePointerId.current !== e.pointerId) return
      updateFromPointer(e.clientX, e.clientY)
    },
    [updateFromPointer],
  )

  const releasePointer = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (activePointerId.current !== e.pointerId) return

      activePointerId.current = null
      input?.clearAnalogVector()
      setStickOffset({ x: 0, y: 0 })
    },
    [input],
  )

  return (
    <div className={styles.joystick}>
      <div
        ref={baseRef}
        className={styles.base}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={releasePointer}
        onPointerCancel={releasePointer}
        onPointerLeave={releasePointer}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className={`${styles.chevron} ${styles.chevronUp}`} />
        <span className={`${styles.chevron} ${styles.chevronRight}`} />
        <span className={`${styles.chevron} ${styles.chevronDown}`} />
        <span className={`${styles.chevron} ${styles.chevronLeft}`} />

        <div className={styles.stick} style={{ transform: `translate(${stickOffset.x}px, ${stickOffset.y}px)` }} />
      </div>
    </div>
  )
}
