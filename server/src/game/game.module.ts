import { Module } from "@nestjs/common"
import { GameGateway } from "./game.gateway"
import { RoomService } from "./room.service"
import { GameService } from "./game.service"
import { GameLoopService } from "./game-loop.service"

/**
 * Единственный модуль сервера — вся co-op-механика (комнаты, авторитетное
 * состояние, тиковый цикл, сам Socket.IO-гейтвей) живёт тут. Single player
 * этот модуль вообще не задействует: клиент в solo-режиме сюда не
 * подключается (см. game/network/GameNetworkStore.ts на клиенте).
 */
@Module({
  providers: [GameGateway, RoomService, GameService, GameLoopService],
})
export class GameModule {}
