"use client"

import { useState } from "react"
import Game from "@/components/Game/Game"
import ModeSelect from "@/components/Game/ModeSelect"
import RoomStatusBadge from "@/components/Game/RoomStatusBadge"

export default function Home() {
  const [isReady, setIsReady] = useState(false)

  if (!isReady) {
    return <ModeSelect onReady={() => setIsReady(true)} />
  }

  return (
    <>
      <RoomStatusBadge />
      <Game />
    </>
  )
}
