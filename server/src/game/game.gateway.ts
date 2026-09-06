import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets"
import type { Server, Socket } from "socket.io"
import type {
  JoinRoomAck,
  JoinRoomPayload,
  LevelCompletePayload,
  PlayerInput,
  PlayerPosePayload,
  PlayerTransformPayload,
} from "../../../shared/game-protocol"
import { RoomService } from "./room.service"
import { GameService } from "./game.service"
import { GameLoopService } from "./game-loop.service"

/** Данные, которые гейтвей прикрепляет к сокету после успешного joinRoom —
 * socket.io типизирует client.data как unknown/any, поэтому объявляем форму сами. */
interface SocketSessionData {
  sessionId?: string
  roomId?: string
  playerId?: string
}

type GameSocket = Socket & { data: SocketSessionData }

@WebSocketGateway({
  cors: { origin: process.env.FRONTEND_URL ?? "http://localhost:3000", credentials: true },
})
export class GameGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server

  constructor(
    private readonly roomService: RoomService,
    private readonly gameService: GameService,
    private readonly gameLoop: GameLoopService,
  ) {}

  public afterInit(server: Server): void {
    this.gameLoop.attachServer(server)
  }

  /**
   * Единственная точка входа в co-op: автоматически находит комнату co
   * свободным местом (auto-join) или создаёт новую (auto-create), либо — если
   * sessionId уже известен — переподключает игрока туда, где он был
   * (reconnect по sessionId). Ack возвращается тем же путём, что и обычный
   * return из хендлера — Nest сам вызовет callback клиента с этим значением.
   */
  @SubscribeMessage("joinRoom")
  public handleJoinRoom(@ConnectedSocket() client: GameSocket, @MessageBody() payload: JoinRoomPayload): JoinRoomAck {
    if (payload?.mode !== "coop") {
      return { ok: false, error: "Сервер обслуживает только co-op — single player работает полностью локально на клиенте." }
    }
    if (!payload.sessionId) {
      return { ok: false, error: "sessionId обязателен" }
    }

    const { room, player, isReconnect } = this.roomService.joinRoom(payload.sessionId, payload.roomId)

    this.roomService.attachSocket(payload.sessionId, client.id)
    client.join(room.roomId)
    client.data.sessionId = payload.sessionId
    client.data.roomId = room.roomId
    client.data.playerId = player.playerId

    this.gameService.ensurePlayerState(room.roomId, player.playerId)

    const roomInfo = this.roomService.toRoomInfo(room)
    this.server.to(room.roomId).emit("roomUpdated", roomInfo)

    if (!isReconnect) {
      client.to(room.roomId).emit("playerJoined", { playerId: player.playerId })
    }

    return { ok: true, room: roomInfo, playerId: player.playerId }
  }

  /** Синхронизация движения — сервер только ЗАПОМИНАЕТ последний ввод, сама
   * интеграция позиции происходит в GameLoopService (server authoritative). */
  @SubscribeMessage("playerInput")
  public handlePlayerInput(@ConnectedSocket() client: GameSocket, @MessageBody() input: PlayerInput): void {
    const playerId = client.data.playerId
    if (!playerId) return

    this.gameService.queueInput(playerId, input)
  }

  /** Реальный путь синхронизации в Twin Morph — см. комментарий в GameService:
   * позиция уже честно посчитана клиентом (его собственным Worm/Ant с учётом
   * стен), сервер только сохраняет и ретранслирует её остальным в комнате. */
  @SubscribeMessage("playerPose")
  public handlePlayerPose(@ConnectedSocket() client: GameSocket, @MessageBody() payload: PlayerPosePayload): void {
    const roomId = client.data.roomId
    const playerId = client.data.playerId
    if (!roomId || !playerId) return

    this.gameService.setPose(roomId, playerId, payload)
  }

  @SubscribeMessage("playerTransform")
  public handlePlayerTransform(@ConnectedSocket() client: GameSocket, @MessageBody() payload: PlayerTransformPayload): void {
    const roomId = client.data.roomId
    if (!roomId) return

    this.gameService.setPlayerForm(roomId, payload.playerId, payload.form)
    this.server.to(roomId).emit("playerTransform", payload)
  }

  /** Критическое игровое событие (прошёл уровень) — сервер просто ретранслирует
   * его второму игроку в комнате; это и есть "синхронизация критических
   * событий между двумя игроками" из требований co-op. */
  @SubscribeMessage("levelComplete")
  public handleLevelComplete(@ConnectedSocket() client: GameSocket, @MessageBody() payload: LevelCompletePayload): void {
    const roomId = client.data.roomId
    if (!roomId) return

    this.server.to(roomId).emit("levelComplete", payload)
  }

  @SubscribeMessage("leaveRoom")
  public handleLeaveRoom(@ConnectedSocket() client: GameSocket): void {
    this.cleanupExplicitLeave(client)
  }

  /** Обрыв связи (закрытие вкладки, потеря сети) — НЕ то же самое, что
   * leaveRoom: игрок помечается "на паузе" и получает шанс на reconnect
   * (см. RoomService.handleSocketDisconnect + RECONNECT_GRACE_MS). */
  public handleDisconnect(client: GameSocket): void {
    const roomId = client.data.roomId
    const playerId = client.data.playerId
    if (!roomId || !playerId) return

    this.roomService.handleSocketDisconnect(client.id)
    this.server.to(roomId).emit("playerLeft", { playerId })
  }

  private cleanupExplicitLeave(client: GameSocket): void {
    const roomId = client.data.roomId
    const playerId = client.data.playerId
    const sessionId = client.data.sessionId
    if (!roomId || !playerId || !sessionId) return

    const removed = this.roomService.removePlayerImmediately(sessionId)
    this.gameService.removePlayer(roomId, playerId)
    client.leave(roomId)

    this.server.to(roomId).emit("playerLeft", { playerId })

    if (removed?.roomDeleted) {
      this.gameService.removeRoom(roomId)
    } else {
      const room = this.roomService.getRoom(roomId)
      if (room) this.server.to(roomId).emit("roomUpdated", this.roomService.toRoomInfo(room))
    }
  }
}
