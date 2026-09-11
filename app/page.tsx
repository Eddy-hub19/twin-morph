"use client"

import { useState } from "react"
import Game from "@/components/Game/Game"
import ModeSelect from "@/components/Game/ModeSelect"
import RoomStatusBadge from "@/components/Game/RoomStatusBadge"

/** "menu" — экран выбора режима (ModeSelect), "game" — сама игра (Game). В
 * отличие от прежнего булева isReady, отсюда можно и вернуться назад в меню
 * (см. Game.onExitToMenu — пункт "Вийти у головне меню" из паузы). */
type Screen = "menu" | "game"

export default function Home() {
  const [screen, setScreen] = useState<Screen>("menu")

  if (screen === "menu") {
    return <ModeSelect onReady={() => setScreen("game")} />
  }

  return (
    <>
      <RoomStatusBadge />
      <Game onExitToMenu={() => setScreen("menu")} />
    </>
  )
}
