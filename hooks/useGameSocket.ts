"use client"

import { useCallback, useSyncExternalStore } from "react"
import { GameNetworkStore, type ConnectionStatus } from "@/game/network/GameNetworkStore"
import type { GameMode, PlayerForm, RoomInfo } from "@/shared/game-protocol"

export interface UseGameSocketResult {
  mode: GameMode | null
  connectionStatus: ConnectionStatus
  room: RoomInfo | null
  localPlayerId: string | null
  /** Свободных мест в комнате (для co-op-лобби: "ждём второго игрока…"). */
  isWaitingForSecondPlayer: boolean
  startSolo: (form?: PlayerForm) => void
  startCoop: () => Promise<RoomInfo>
  disconnect: () => void
  store: GameNetworkStore
}

const store = GameNetworkStore.getInstance()

const subscribe = (onStoreChange: () => void) => store.subscribe(onStoreChange)
const getSnapshot = () => store.getSnapshot()

/**
 * React-обвязка вокруг GameNetworkStore (singleton) — единственная точка, из
 * которой компоненты (экран выбора режима, HUD "игрок 2 подключился" и т.п.)
 * читают сетевое состояние. Сам игровой цикл Pixi ходит напрямую в
 * store.update()/getLocalPlayerState()/getRemotePlayerStates() — этому не
 * нужен React-рендер на каждый кадр, поэтому здесь только состояние комнаты/
 * соединения, а не позиции игроков (те меняются 60 раз в секунду).
 */
export function useGameSocket(): UseGameSocketResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const startSolo = useCallback((form?: PlayerForm) => store.startSolo(form), [])
  const startCoop = useCallback(() => store.startCoop(), [])
  const disconnect = useCallback(() => store.disconnect(), [])

  const isWaitingForSecondPlayer =
    snapshot.mode === "coop" && snapshot.roomInfo !== null && snapshot.roomInfo.players.length < snapshot.roomInfo.maxPlayers

  return {
    mode: snapshot.mode,
    connectionStatus: snapshot.connectionStatus,
    room: snapshot.roomInfo,
    localPlayerId: snapshot.localPlayerId,
    isWaitingForSecondPlayer,
    startSolo,
    startCoop,
    disconnect,
    store,
  }
}
