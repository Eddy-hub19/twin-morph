"use client"

import { useEffect, useRef, useState } from "react"
import { Engine } from "@/game/core/Engine"
import type { InputManager } from "@/game/input/InputManager"

import TouchControls from "./TouchControls"
import styles from "./Game.module.scss"

/** Только для dev — временный FPS-индикатор (см. Engine.setFpsListener).
 * process.env.NODE_ENV гарантированно "production" только в next build/next
 * start (тот же конвент уже используется в game/network/GameSocket.ts), так
 * что в проде этот блок вообще не попадает в бандл — не просто скрыт стилями. */
const SHOW_FPS_OVERLAY = process.env.NODE_ENV !== "production"

export default function Game() {
  const containerRef = useRef<HTMLDivElement>(null)
  const fpsRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState<InputManager | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Если компонент размонтируется до того, как initialize() (async) успеет
    // отработать, cancelled не даёт "ожить" уже ненужному Engine — вместо
    // этого он тут же уничтожается сразу по готовности (см. .then ниже).
    let cancelled = false
    const engine = new Engine(containerRef.current)

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

  return (
    <div ref={containerRef} className={styles.game} onContextMenu={(e) => e.preventDefault()}>
      <TouchControls input={input} />
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
