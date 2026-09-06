"use client"

import { useState } from "react"
import { useGameSocket } from "@/hooks/useGameSocket"
import styles from "./ModeSelect.module.scss"

/**
 * Небольшой постоянный индикатор поверх игры в co-op — сколько игроков сейчас
 * в комнате, плюс кнопка скопировать ссылку-приглашение (адресная строка уже
 * содержит ?room=<id> — см. ModeSelect.setRoomInUrl). В single player ничего
 * не рендерит (room всегда null).
 */
export default function RoomStatusBadge() {
  const { mode, room, connectionStatus, isWaitingForSecondPlayer } = useGameSocket()
  const [copied, setCopied] = useState(false)

  if (mode !== "coop" || !room) return null

  const label = isWaitingForSecondPlayer
    ? `Комната ${room.roomId.slice(0, 8)} · ждём второго игрока…`
    : `Комната ${room.roomId.slice(0, 8)} · игроков: ${room.players.length}/${room.maxPlayers}`

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Буфер обмена может быть недоступен (нет разрешения/не https) — не
      // ломаем игру, просто ссылка не скопируется, ей всё ещё можно
      // поделиться, скопировав адресную строку вручную.
    }
  }

  return (
    <div className={styles.roomBadge}>
      <span>{connectionStatus === "connected" ? label : "Переподключение…"}</span>
      {isWaitingForSecondPlayer && (
        <button type="button" className={styles.copyLinkButton} onClick={handleCopyLink}>
          {copied ? "Скопировано!" : "Скопировать ссылку"}
        </button>
      )}
    </div>
  )
}
