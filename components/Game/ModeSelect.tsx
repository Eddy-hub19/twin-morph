"use client"

import { useState } from "react"
import { useGameSocket } from "@/hooks/useGameSocket"
import styles from "./ModeSelect.module.scss"

interface ModeSelectProps {
  /** Вызывается, как только режим выбран и (для co-op) комната успешно получена. */
  onReady: () => void
}

/**
 * Экран выбора режима перед стартом — ровно то, что требует "выбор режима
 * перед стартом" в задаче. Single Player стартует мгновенно, без единого
 * обращения к сети. Co-op подключается к NestJS-серверу через useGameSocket
 * (GameSocket/GameNetworkStore под капотом) и ждёт ack от комнаты, прежде
 * чем пускать в игру.
 */
export default function ModeSelect({ onReady }: ModeSelectProps) {
  const { startSolo, startCoop } = useGameSocket()
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSolo = () => {
    startSolo("worm")
    onReady()
  }

  const handleCoop = async () => {
    setError(null)
    setIsConnecting(true)
    try {
      await startCoop()
      onReady()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось подключиться к серверу co-op")
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <div className={styles.overlay}>
      <h1 className={styles.title}>Twin Morph</h1>
      <p className={styles.subtitle}>Выбери режим — червяк копает под землёй, муравей бежит по поверхности.</p>

      <div className={styles.options}>
        <button className={styles.option} onClick={handleSolo} disabled={isConnecting}>
          <span className={styles.optionIcon}>🐛</span>
          <span className={styles.optionLabel}>Single Player</span>
          <span className={styles.optionHint}>Играть одному, без сети</span>
        </button>

        <button className={styles.option} onClick={handleCoop} disabled={isConnecting}>
          <span className={styles.optionIcon}>🐜</span>
          <span className={styles.optionLabel}>Co-op (2 игрока)</span>
          <span className={styles.optionHint}>{isConnecting ? "Подключение…" : "Подключиться к комнате"}</span>
        </button>
      </div>

      <div className={styles.status}>{error && <span className={styles.error}>{error}</span>}</div>
    </div>
  )
}
