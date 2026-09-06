"use client"

import { useGameSocket } from "@/hooks/useGameSocket"
import styles from "./ModeSelect.module.scss"

/**
 * Небольшой постоянный индикатор поверх игры в co-op — сколько игроков сейчас
 * в комнате. В single player ничего не рендерит (room всегда null).
 */
export default function RoomStatusBadge() {
  const { mode, room, connectionStatus, isWaitingForSecondPlayer } = useGameSocket()

  if (mode !== "coop" || !room) return null

  const label = isWaitingForSecondPlayer
    ? `Комната ${room.roomId.slice(0, 8)} · ждём второго игрока…`
    : `Комната ${room.roomId.slice(0, 8)} · игроков: ${room.players.length}/${room.maxPlayers}`

  return <div className={styles.roomBadge}>{connectionStatus === "connected" ? label : "Переподключение…"}</div>
}
