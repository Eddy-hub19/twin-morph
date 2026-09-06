import { Injectable } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import { MAX_PLAYERS_PER_ROOM, RECONNECT_GRACE_MS, type RoomInfo } from "../../../shared/game-protocol"

export interface RoomPlayer {
  playerId: string
  sessionId: string
  /** null, пока игрок физически не подключён (первый вход ещё не завершён,
   * либо сейчас "на паузе" после обрыва соединения — см. connected). */
  socketId: string | null
  connected: boolean
  /** Когда именно отключился — используется для sweepStaleDisconnects. */
  disconnectedAt: number | null
}

export interface Room {
  roomId: string
  mode: "coop"
  players: RoomPlayer[]
  createdAt: number
}

export interface JoinRoomResult {
  room: Room
  player: RoomPlayer
  /** true, если это возврат уже известного sessionId (reconnect), а не новый игрок. */
  isReconnect: boolean
}

export interface RemovedPlayerEntry {
  roomId: string
  playerId: string
  roomDeleted: boolean
}

/**
 * Управляет комнатами co-op (максимум MAX_PLAYERS_PER_ROOM игроков каждая),
 * автосозданием/автоприсоединением и reconnect по sessionId. Ничего не знает
 * про сокеты Socket.IO напрямую (кроме socketId как строкового id) — гейтвей
 * (game.gateway.ts) сам решает, что делать с client.join()/emit().
 */
@Injectable()
export class RoomService {
  private rooms = new Map<string, Room>()
  /** sessionId -> текущее местоположение игрока — быстрый путь для reconnect. */
  private sessionIndex = new Map<string, { roomId: string; playerId: string }>()

  /**
   * Присоединяет к комнате (или создаёт её) по sessionId. Если sessionId уже
   * встречался раньше и его комната/игрок ещё существуют (grace-период не
   * истёк) — это reconnect: игрок просто помечается снова подключённым, без
   * создания нового playerId (это и есть "server authoritative": позиция не
   * пересоздаётся с нуля, она продолжается с того места, где сервер её
   * авторитетно держал всё время отключения).
   */
  public joinRoom(sessionId: string, requestedRoomId?: string): JoinRoomResult {
    const reconnected = this.tryReconnect(sessionId)
    if (reconnected) return reconnected

    const room = this.findRoomToJoin(requestedRoomId) ?? this.createRoom()

    const player: RoomPlayer = {
      playerId: randomUUID(),
      sessionId,
      socketId: null,
      connected: true,
      disconnectedAt: null,
    }
    room.players.push(player)
    this.sessionIndex.set(sessionId, { roomId: room.roomId, playerId: player.playerId })

    return { room, player, isReconnect: false }
  }

  private tryReconnect(sessionId: string): JoinRoomResult | null {
    const location = this.sessionIndex.get(sessionId)
    if (!location) return null

    const room = this.rooms.get(location.roomId)
    const player = room?.players.find((p) => p.playerId === location.playerId)

    if (!room || !player) {
      // Комната или игрок уже вычищены (grace-период истёк) — забываем
      // устаревшую привязку, дальше joinRoom заведёт игрока заново.
      this.sessionIndex.delete(sessionId)
      return null
    }

    player.connected = true
    player.disconnectedAt = null
    return { room, player, isReconnect: true }
  }

  private findRoomToJoin(requestedRoomId?: string): Room | undefined {
    if (requestedRoomId) {
      const requested = this.rooms.get(requestedRoomId)
      if (requested && requested.players.length < MAX_PLAYERS_PER_ROOM) return requested
    }

    for (const room of this.rooms.values()) {
      if (room.players.length < MAX_PLAYERS_PER_ROOM) return room
    }

    return undefined
  }

  private createRoom(): Room {
    const room: Room = { roomId: randomUUID(), mode: "coop", players: [], createdAt: Date.now() }
    this.rooms.set(room.roomId, room)
    return room
  }

  /** Привязывает текущий физический сокет к уже присоединённому игроку. */
  public attachSocket(sessionId: string, socketId: string): void {
    const location = this.sessionIndex.get(sessionId)
    if (!location) return

    const player = this.rooms.get(location.roomId)?.players.find((p) => p.playerId === location.playerId)
    if (player) player.socketId = socketId
  }

  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId)
  }

  public getAllRooms(): Room[] {
    return [...this.rooms.values()]
  }

  public toRoomInfo(room: Room): RoomInfo {
    return {
      roomId: room.roomId,
      mode: room.mode,
      maxPlayers: MAX_PLAYERS_PER_ROOM,
      players: room.players.map((p) => ({ playerId: p.playerId, sessionId: p.sessionId, connected: p.connected })),
    }
  }

  /** Сокет физически отвалился (сеть/закрытие вкладки) — НЕ удаляем игрока
   * сразу, только помечаем "на паузе" (см. RECONNECT_GRACE_MS). */
  public handleSocketDisconnect(socketId: string): { roomId: string; playerId: string } | null {
    for (const room of this.rooms.values()) {
      const player = room.players.find((p) => p.socketId === socketId)
      if (player) {
        player.connected = false
        player.disconnectedAt = Date.now()
        player.socketId = null
        return { roomId: room.roomId, playerId: player.playerId }
      }
    }
    return null
  }

  /** Явный выход (leaveRoom) — в отличие от обрыва связи, тут удаляем сразу, без grace-периода. */
  public removePlayerImmediately(sessionId: string): RemovedPlayerEntry | null {
    const location = this.sessionIndex.get(sessionId)
    if (!location) return null

    const room = this.rooms.get(location.roomId)
    if (!room) return null

    room.players = room.players.filter((p) => p.playerId !== location.playerId)
    this.sessionIndex.delete(sessionId)

    const roomDeleted = room.players.length === 0
    if (roomDeleted) this.rooms.delete(room.roomId)

    return { roomId: room.roomId, playerId: location.playerId, roomDeleted }
  }

  /**
   * Вызывается периодически из GameLoopService: окончательно убирает
   * игроков, которые отвалились больше RECONNECT_GRACE_MS назад и не
   * вернулись — это disconnect cleanup, отделённый от самого disconnect,
   * чтобы моргнувшая на секунду сеть не выкидывала игрока из комнаты.
   */
  public sweepStaleDisconnects(): RemovedPlayerEntry[] {
    const removed: RemovedPlayerEntry[] = []
    const now = Date.now()

    for (const room of this.rooms.values()) {
      const stalePlayers = room.players.filter(
        (p) => !p.connected && p.disconnectedAt !== null && now - p.disconnectedAt > RECONNECT_GRACE_MS,
      )

      for (const player of stalePlayers) {
        room.players = room.players.filter((p) => p.playerId !== player.playerId)
        this.sessionIndex.delete(player.sessionId)
        removed.push({ roomId: room.roomId, playerId: player.playerId, roomDeleted: room.players.length === 0 })
      }
    }

    for (const entry of removed) {
      if (entry.roomDeleted) this.rooms.delete(entry.roomId)
    }

    return removed
  }
}
