"use client"

import { useEffect, useRef, useState } from "react"
import { Engine } from "@/game/core/Engine"
import type { InputManager } from "@/game/input/InputManager"
import { useGameSocketActions } from "@/hooks/useGameSocket"

import TouchControls from "./TouchControls"
import PauseButton from "./PauseButton"
import PauseMenu from "./PauseMenu"
import styles from "./Game.module.scss"

/** Только для dev — временный FPS-индикатор (см. Engine.setFpsListener).
 * process.env.NODE_ENV гарантированно "production" только в next build/next
 * start (тот же конвент уже используется в game/network/GameSocket.ts), так
 * что в проде этот блок вообще не попадает в бандл — не просто скрыт стилями. */
const SHOW_FPS_OVERLAY = process.env.NODE_ENV !== "production"

interface GameProps {
  /** "Вийти у головне меню" из PauseMenu — размонтирует Game и возвращает
   * app/page.tsx к ModeSelect. Сам Engine/сцену тут не трогаем — обычный
   * cleanup эффекта ниже это сделает при размонтировании. */
  onExitToMenu: () => void
}

export default function Game({ onExitToMenu }: GameProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const fpsRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const [input, setInput] = useState<InputManager | null>(null)
  const [paused, setPaused] = useState(false)
  // useGameSocketActions — НЕ useGameSocket(): Game не читает ни один
  // сетевой снапшот (mode/connectionStatus/room/...), ему нужен только
  // disconnect() при выходе в меню, а useGameSocket() подписал бы этот
  // компонент на useSyncExternalStore и заставил бы его ре-рендериться при
  // каждом notify() стора (см. комментарий у useGameSocketActions).
  const { disconnect } = useGameSocketActions()

  useEffect(() => {
    if (!containerRef.current) return

    // Если компонент размонтируется до того, как initialize() (async) успеет
    // отработать, cancelled не даёт "ожить" уже ненужному Engine — вместо
    // этого он тут же уничтожается сразу по готовности (см. .then ниже).
    let cancelled = false
    // true, как только initialize() реально резолвится — при обычном
    // (не мгновенном) unmount к этому моменту Engine уже полностью собран
    // (ticker/рендерер существуют), и cleanup ниже может звать destroy()
    // прямо сейчас, синхронно, а не откладывать это до чужого .then().
    let initialized = false
    const engine = new Engine(containerRef.current)
    engineRef.current = engine

    // engine.destroy() сам по себе идемпотентен (Engine.destroy — no-op при
    // повторном вызове), но destroyOnce всё равно нужен: без него первый же
    // vs. второй путь (cleanup synchronously vs. .then() ниже) могли бы оба
    // отработать по разу за один и тот же unmount (см. оба места вызова).
    let destroyedOnce = false
    const destroyOnce = () => {
      if (destroyedOnce) return
      destroyedOnce = true
      engine.destroy()
    }

    engine.initialize().then(() => {
      initialized = true

      if (cancelled) {
        // Unmount успел случиться, пока initialize() (async) ещё выполнялась
        // — только сейчас Engine стал полностью собран (ticker/рендерер уже
        // существуют), и только сейчас destroy() безопасен.
        destroyOnce()
        return
      }

      setInput(engine.input)

      if (SHOW_FPS_OVERLAY) {
        engine.setFpsListener((fps) => {
          if (fpsRef.current) fpsRef.current.textContent = `${Math.round(fps)} FPS`
        })
      }
    })

    return () => {
      cancelled = true
      engineRef.current = null

      if (initialized) {
        // Обычный случай: initialize() уже успела отработать к моменту
        // unmount — уничтожаем Engine (ticker/InputManager/сцена/canvas)
        // прямо тут. Раньше этот путь не был покрыт вообще: cancelled
        // выставлялся, но ничего не вызывало destroy(), раз .then() выше уже
        // успел отработать до unmount — Engine, его ticker и canvas просто
        // оставались висеть в памяти навсегда при каждом обычном возврате в
        // меню.
        destroyOnce()
      }
      // Иначе initialize() всё ещё выполняется (например, React StrictMode
      // в dev, синхронно размонтирующий сразу после монтирования, или очень
      // быстрый выход прямо во время загрузки) — cancelled=true выше
      // заставит .then() уничтожить Engine сразу по готовности, а не тут:
      // на этот момент PIXI Application мог быть только что создан, но ещё
      // не полностью инициализирован (ticker/рендерер ещё не существуют), и
      // destroy() тут же упал бы на попытке снять несуществующий тикер.
    }
  }, [])

  // Пауза — единственная точка, которая реально дёргает Engine.setPaused
  // (см. GameScene.setPaused): и кнопка, и Escape ниже лишь меняют это
  // состояние, а применяется оно тут, синхронно с рендером PauseMenu.
  useEffect(() => {
    engineRef.current?.setPaused(paused)
  }, [paused])

  // Escape — то же самое, что и клик по PauseButton/"Продовжити", просто с
  // клавиатуры (десктоп). На сенсорных экранах, где Escape нет, для этого
  // есть сам PauseButton.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return
      setPaused((prev) => !prev)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  const handleRestart = () => {
    engineRef.current?.restartLevel()
    setPaused(false)
  }

  const handleExitToMenu = () => {
    // В single player это скорее формальность (сброс локального состояния
    // стора), но в co-op — обязательный шаг: иначе сокет остаётся
    // подключённым к комнате и после возврата в меню (см. GameNetworkStore.
    // disconnect — leaveRoom + полный reset()).
    disconnect()
    onExitToMenu()
  }

  return (
    <div ref={containerRef} className={styles.game} onContextMenu={(e) => e.preventDefault()}>
      <TouchControls input={input} />
      {input && !paused && <PauseButton onClick={() => setPaused(true)} />}
      {input && paused && (
        <PauseMenu onContinue={() => setPaused(false)} onRestart={handleRestart} onExitToMenu={handleExitToMenu} />
      )}
      {SHOW_FPS_OVERLAY && (
        <div
          ref={fpsRef}
          style={{
            position: "absolute",
            top: 4,
            left: 4,
            padding: "2px 6px",
            background: "rgba(0,0,0,0.5)",
            color: "#0f0",
            font: "12px monospace",
            pointerEvents: "none",
            zIndex: 9999,
          }}
        >
          … FPS
        </div>
      )}
    </div>
  )
}
