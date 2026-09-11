"use client"

import { useEffect, useRef, useState } from "react"
import { Engine } from "@/game/core/Engine"
import type { InputManager } from "@/game/input/InputManager"
import { useGameSocket } from "@/hooks/useGameSocket"

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
  const { disconnect } = useGameSocket()

  useEffect(() => {
    if (!containerRef.current) return

    // Если компонент размонтируется до того, как initialize() (async) успеет
    // отработать, cancelled не даёт "ожить" уже ненужному Engine — вместо
    // этого он тут же уничтожается сразу по готовности (см. .then ниже).
    let cancelled = false
    const engine = new Engine(containerRef.current)
    engineRef.current = engine

    engine.initialize().then(() => {
      if (cancelled) {
        engine.destroy()
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
      // НЕ вызываем engine.destroy() прямо тут: initialize() (см. выше) —
      // асинхронный (await app.init(), await AssetLoader.load()), и на
      // момент немедленного unmount (например, React StrictMode в dev,
      // синхронно размонтирующий сразу после монтирования) PIXI Application
      // мог быть только что создан (this.app уже не null), но ещё не
      // полностью инициализирован (ticker/рендерер ещё не существуют) —
      // destroy() в этот момент падает на попытке снять несуществующий
      // тикер. Настоящее уничтожение — исключительно в .then() выше, когда
      // initialize() реально завершилась (и cancelled уже true, если мы
      // сюда попали до этого) — то есть уничтожение просто откладывается до
      // готовности, а не пропускается.
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
