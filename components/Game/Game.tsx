"use client"

import { useEffect, useRef, useState } from "react"
import { Engine } from "@/game/core/Engine"
import type { InputManager } from "@/game/input/InputManager"

import TouchControls from "./TouchControls"
import styles from "./Game.module.scss"

export default function Game() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState<InputManager | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const engine = new Engine(containerRef.current)

    engine.initialize()
    setInput(engine.input)

    return () => {
      // Позже здесь будет engine.destroy()
    }
  }, [])

  return (
    <div ref={containerRef} className={styles.game} onContextMenu={(e) => e.preventDefault()}>
      <TouchControls input={input} />
    </div>
  )
}
