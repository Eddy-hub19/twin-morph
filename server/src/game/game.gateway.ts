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
  AdvanceLevelPayload,
  BoostActivatePayload,
  EnemyStatePayload,
  EnsureLevelAck,
  EnsureLevelPayload,
  JoinRoomAck,
  JoinRoomPayload,
  LevelCompletePayload,
  LightActivatePayload,
  PlayerInput,
  PlayerPosePayload,
  PlayerTransformPayload,
  RoomRestartRequestPayload,
  StarPickupPayload,
  WallHitPayload,
} from "../../../shared/game-protocol"
import { RoomService } from "./room.service"
import { GameService } from "./game.service"
import { GameLoopService } from "./game-loop.service"
import { LevelStateService } from "./level-state.service"
import { getFrontendUrl } from "../frontend-url"

/** Данные, которые гейтвей прикрепляет к сокету после успешного joinRoom —
 * socket.io типизирует client.data как unknown/any, поэтому объявляем форму сами. */
interface SocketSessionData {
  sessionId?: string
  roomId?: string
  playerId?: string
}

type GameSocket = Socket & { data: SocketSessionData }

@WebSocketGateway({
  cors: { origin: getFrontendUrl(), credentials: true },
})
export class GameGateway implements OnGatewayInit, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server

  constructor(
    private readonly roomService: RoomService,
    private readonly gameService: GameService,
    private readonly gameLoop: GameLoopService,
    private readonly levelState: LevelStateService,
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

    // Общий мир копания — новый/переподключившийся игрок получает ПОЛНЫЙ
    // текущий снапшот комнаты (seed + дифф прогрызенных клеток + кто уже
    // забрал предметы + таймеры + враги) прямо в ack, а не начинает с чистой
    // карты с нуля (levelState === null только у самой первой заявки в
    // свежую комнату — тогда этот же клиент сам заведёт его через ensureLevel).
    return {
      ok: true,
      room: roomInfo,
      playerId: player.playerId,
      epoch: this.levelState.getEpoch(room.roomId),
      teamStars: this.levelState.getTeamStars(room.roomId),
      levelState: this.levelState.getLevelState(room.roomId),
    }
  }

  @SubscribeMessage("ensureLevel")
  public handleEnsureLevel(@ConnectedSocket() client: GameSocket, @MessageBody() payload: EnsureLevelPayload): EnsureLevelAck {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return { ok: false }

    const levelState = this.levelState.ensureLevel(roomId, payload.level, payload.width, payload.height)
    return { ok: true, levelState, teamStars: this.levelState.getTeamStars(roomId), epoch: this.levelState.getEpoch(roomId) }
  }

  /** Игрок дошёл до двери с полным общим счётом звёзд — переводит ВСЮ
   * комнату на следующий уровень разом (широковещательно, включая заявителя —
   * единая точка, откуда оба клиента реально выполняют переход). */
  @SubscribeMessage("advanceLevel")
  public handleAdvanceLevel(@ConnectedSocket() client: GameSocket, @MessageBody() payload: AdvanceLevelPayload): EnsureLevelAck {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return { ok: false }

    const levelState = this.levelState.advanceLevel(roomId, payload.fromLevel, payload.toLevel, payload.width, payload.height)
    if (!levelState) return { ok: false } // устаревшая/повторная заявка — комната уже не на fromLevel

    const teamStars = this.levelState.getTeamStars(roomId)
    const epoch = this.levelState.getEpoch(roomId)
    this.server.to(roomId).emit("levelAdvanced", { levelState, teamStars, epoch })

    return { ok: true, levelState, teamStars, epoch }
  }

  /** Игрок погиб на общем уровне — перезапускает ВСЮ комнату (новый seed,
   * новая эпоха, обнулённый общий счёт), иначе карты игроков тут же
   * разошлись бы: не переписываемая иначе местная процедурная генерация. */
  @SubscribeMessage("roomRestart")
  public handleRoomRestart(@ConnectedSocket() client: GameSocket, @MessageBody() payload: RoomRestartRequestPayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    const result = this.levelState.restartRoom(roomId, payload.width, payload.height)
    this.server.to(roomId).emit("roomRestarted", result)
  }

  @SubscribeMessage("wallHit")
  public handleWallHit(@ConnectedSocket() client: GameSocket, @MessageBody() payload: WallHitPayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    const recorded = this.levelState.recordWallHit(roomId, payload.level, payload.cellKey, payload.hits)
    if (!recorded) return // устаревшее событие для уже неактуального уровня — молча игнорируем

    // Отправитель уже применил удар у себя оптимистично — рассылаем только остальным.
    client.to(roomId).emit("wallUpdated", {
      level: payload.level,
      epoch: payload.epoch,
      cellKey: payload.cellKey,
      hits: payload.hits,
      destroyed: payload.destroyed,
    })
  }

  @SubscribeMessage("starPickup")
  public handleStarPickup(@ConnectedSocket() client: GameSocket, @MessageBody() payload: StarPickupPayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    const teamStars = this.levelState.collectStar(roomId, payload.level, payload.starId)
    if (teamStars === null) return // уже засчитана кем-то раньше — не даём засчитать дважды

    // Рассылаем ВСЕЙ комнате, включая отправителя — единственный источник
    // истины про общий счёт, а не локальный оптимистичный инкремент.
    this.server.to(roomId).emit("starCollected", { level: payload.level, epoch: payload.epoch, starId: payload.starId, teamStars })
  }

  @SubscribeMessage("lightActivate")
  public handleLightActivate(@ConnectedSocket() client: GameSocket, @MessageBody() payload: LightActivatePayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    const lightEndsAt = this.levelState.activateLight(roomId, payload.level, payload.switchId)
    if (lightEndsAt === null) return

    this.server.to(roomId).emit("lightUpdate", { level: payload.level, epoch: payload.epoch, switchId: payload.switchId, lightEndsAt })
  }

  @SubscribeMessage("boostActivate")
  public handleBoostActivate(@ConnectedSocket() client: GameSocket, @MessageBody() payload: BoostActivatePayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    const result = this.levelState.activateBoost(roomId, payload.level, payload.bubbleId, payload.kind)
    if (!result) return

    this.server.to(roomId).emit("boostUpdate", {
      level: payload.level,
      epoch: payload.epoch,
      bubbleId: payload.bubbleId,
      kind: payload.kind,
      lightRadiusBonus: result.lightRadiusBonus,
      speedBoostEndsAt: result.speedBoostEndsAt,
    })
  }

  /** Только "хост" комнаты (первый по RoomInfo.players) реально шлёт это —
   * сервер лишь хранит последнее известное состояние (для снапшота новому
   * игроку) и ретранслирует его партнёру, саму симуляцию не пересчитывает. */
  @SubscribeMessage("enemyState")
  public handleEnemyState(@ConnectedSocket() client: GameSocket, @MessageBody() payload: EnemyStatePayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    this.levelState.setEnemies(roomId, payload.level, payload.enemies)
    client.to(roomId).emit("enemyState", payload)
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
      this.levelState.removeRoom(roomId)
    } else {
      const room = this.roomService.getRoom(roomId)
      if (room) this.server.to(roomId).emit("roomUpdated", this.roomService.toRoomInfo(room))
    }
  }
}
