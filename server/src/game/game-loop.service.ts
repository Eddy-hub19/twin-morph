import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common"
import type { Server } from "socket.io"
import { SERVER_TICK_MS } from "../../../shared/game-protocol"
import { RoomService } from "./room.service"
import { GameService } from "./game.service"
import { LevelStateService } from "./level-state.service"

/**
 * Единственный игровой цикл сервера — фиксированный тик (SERVER_TICK_MS),
 * независимо от того, сколько комнат сейчас активно. На каждом тике:
 *   1) вычищает игроков, которые отвалились дольше RECONNECT_GRACE_MS назад;
 *   2) авторитетно продвигает состояние каждой комнаты и рассылает снапшот
 *      всем в этой комнате (server authoritative state).
 *
 * Gateway вызывает attachServer() из afterInit(server) — до этого рассылать
 * снапшоты просто некуда (Socket.IO сервер ещё не поднят).
 */
@Injectable()
export class GameLoopService implements OnModuleInit, OnModuleDestroy {
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private server: Server | null = null

  constructor(
    private readonly roomService: RoomService,
    private readonly gameService: GameService,
    private readonly levelState: LevelStateService,
  ) {}

  public attachServer(server: Server): void {
    this.server = server
  }

  public onModuleInit(): void {
    this.intervalHandle = setInterval(() => this.tick(), SERVER_TICK_MS)
  }

  public onModuleDestroy(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle)
  }

  private tick(): void {
    this.sweepAndCleanup()

    if (!this.server) return

    for (const room of this.roomService.getAllRooms()) {
      const snapshot = this.gameService.tickRoom(room.roomId, SERVER_TICK_MS / 1000)
      this.server.to(room.roomId).emit("stateSnapshot", snapshot)
    }
  }

  private sweepAndCleanup(): void {
    const removed = this.roomService.sweepStaleDisconnects()

    for (const entry of removed) {
      this.gameService.removePlayer(entry.roomId, entry.playerId)

      if (entry.roomDeleted) {
        this.gameService.removeRoom(entry.roomId)
        this.levelState.removeRoom(entry.roomId)
        continue
      }

      if (!this.server) continue

      const room = this.roomService.getRoom(entry.roomId)
      if (room) {
        this.server.to(entry.roomId).emit("roomUpdated", this.roomService.toRoomInfo(room))
        this.server.to(entry.roomId).emit("playerLeft", { playerId: entry.playerId })
      }
    }
  }
}
