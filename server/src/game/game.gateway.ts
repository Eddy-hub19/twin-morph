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
  BigBranchStatePayload,
  BoostActivatePayload,
  EnemyStatePayload,
  EnsureLevelAck,
  EnsureLevelPayload,
  EnsureWaterSegmentAck,
  EnsureWaterSegmentPayload,
  JoinRoomAck,
  JoinRoomPayload,
  LevelCompletePayload,
  LightActivatePayload,
  MaterialGrabAck,
  MaterialGrabPayload,
  MaterialInstallAck,
  MaterialInstallPayload,
  PlayerInput,
  PlayerPosePayload,
  PlayerTransformPayload,
  RoomRestartRequestPayload,
  StarPickupPayload,
  WallHitPayload,
  WaterItemPickupPayload,
  WaterPassageEnterPayload,
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
      frogProgress: this.gameService.getFrogProgress(player.playerId),
      waterLevelState: this.levelState.getWaterSegmentState(room.roomId, 3),
    }
  }

  @SubscribeMessage("ensureLevel")
  public handleEnsureLevel(@ConnectedSocket() client: GameSocket, @MessageBody() payload: EnsureLevelPayload): EnsureLevelAck {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return { ok: false }

    const levelState = this.levelState.ensureLevel(roomId, payload.level, payload.width, payload.height)
    return { ok: true, levelState, teamStars: this.levelState.getTeamStars(roomId), epoch: this.levelState.getEpoch(roomId) }
  }

  /** Уровни 3+ (жаба, вода) — см. комментарий у WaterSegmentState. В отличие
   * от ensureLevel выше, не требует, чтобы вся комната была на одном номере
   * уровня: прогресс на воде независим у каждого игрока. Заодно запоминаем
   * "этот игрок сейчас на level" — единственное, что нужно, чтобы отдать
   * позднему присоединению/реконнекту JoinRoomAck.frogProgress. */
  @SubscribeMessage("ensureWaterSegment")
  public handleEnsureWaterSegment(
    @ConnectedSocket() client: GameSocket,
    @MessageBody() payload: EnsureWaterSegmentPayload,
  ): EnsureWaterSegmentAck {
    const roomId = client.data.roomId
    const playerId = client.data.playerId
    if (!roomId || !playerId || roomId !== payload.roomId) return { ok: false }

    const segment = this.levelState.ensureWaterSegment(roomId, payload.level, payload.width, payload.height)
    this.gameService.setFrogProgress(playerId, payload.level)

    return { ok: true, segment }
  }

  /** Уровень 3 — подобрал кувшинку/ключ (навсегда для всей комнаты, тот же
   * принцип, что и starPickup выше). */
  @SubscribeMessage("waterItemPickup")
  public handleWaterItemPickup(@ConnectedSocket() client: GameSocket, @MessageBody() payload: WaterItemPickupPayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    const result = this.levelState.collectWaterItem(roomId, payload.level, payload.itemId, payload.isKey)
    if (!result) return // уже собран кем-то раньше — не даём засчитать дважды

    this.server.to(roomId).emit("waterItemCollected", {
      level: payload.level,
      itemId: payload.itemId,
      isKey: payload.isKey,
      keyFound: result.keyFound,
    })
  }

  /** Уровень 3 — коснулся уже открытого прохода: заводит RoomLevelState
   * уровня 4 и рассылает его ОБОИМ игрокам комнаты сразу — единственный
   * момент во всей водной фазе, где снова нужен общий "переход для всех",
   * см. комментарий у WaterSegmentState в shared/game-protocol.ts. */
  @SubscribeMessage("waterPassageEnter")
  public handleWaterPassageEnter(@ConnectedSocket() client: GameSocket, @MessageBody() payload: WaterPassageEnterPayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    const levelState = this.levelState.enterWaterPassage(roomId, payload.level, payload.width, payload.height)
    if (!levelState) return // ключ ещё не найден (клиенту не доверяем) или проход уже пройден раньше

    this.server.to(roomId).emit("waterPassageEntered", { levelState })
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

  /** Уровень 2 (пруд/міст): клеймить матеріал за гравцем — успіх, лише якщо
   * він ще нічий і не встановлений. Відправник вже застосував це у себе
   * оптимістично, тож розсилаємо ОБОМ (включно з відправником — єдине
   * джерело істини) лише при успіху, як starPickup. */
  @SubscribeMessage("materialGrab")
  public handleMaterialGrab(@ConnectedSocket() client: GameSocket, @MessageBody() payload: MaterialGrabPayload): MaterialGrabAck {
    const roomId = client.data.roomId
    const playerId = client.data.playerId
    if (!roomId || !playerId || roomId !== payload.roomId) return { ok: false }

    const ok = this.levelState.grabMaterial(roomId, payload.level, payload.materialId, playerId)
    if (ok) {
      this.server.to(roomId).emit("materialUpdated", { level: payload.level, epoch: payload.epoch, materialId: payload.materialId, carrierId: playerId })
    }
    return { ok }
  }

  /** Носій утонув/випустив матеріал — знімає клейм і повідомляє решту кімнати,
   * щоб матеріал знову став видимим на своєму місці спавну. */
  @SubscribeMessage("materialRelease")
  public handleMaterialRelease(@ConnectedSocket() client: GameSocket, @MessageBody() payload: MaterialGrabPayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    this.levelState.releaseMaterial(roomId, payload.level, payload.materialId)
    this.server.to(roomId).emit("materialUpdated", { level: payload.level, epoch: payload.epoch, materialId: payload.materialId, carrierId: null })
  }

  @SubscribeMessage("materialInstall")
  public handleMaterialInstall(@ConnectedSocket() client: GameSocket, @MessageBody() payload: MaterialInstallPayload): MaterialInstallAck {
    const roomId = client.data.roomId
    const playerId = client.data.playerId
    if (!roomId || !playerId || roomId !== payload.roomId) return { ok: false }

    const ok = this.levelState.installMaterial(roomId, payload.level, payload.materialId, payload.slotId, playerId)
    if (ok) {
      this.server.to(roomId).emit("slotUpdated", { level: payload.level, epoch: payload.epoch, slotId: payload.slotId, materialId: payload.materialId })
    }
    return { ok }
  }

  /** Тільки хост кімнати реально рахує прогрес великої гілки (як enemyState
   * вище) — сервер лише зберігає останнє значення і ретранслює партнеру. */
  @SubscribeMessage("bigBranchState")
  public handleBigBranchState(@ConnectedSocket() client: GameSocket, @MessageBody() payload: BigBranchStatePayload): void {
    const roomId = client.data.roomId
    if (!roomId || roomId !== payload.roomId) return

    this.levelState.setBigBranchState(roomId, payload.level, payload.progress, payload.carrierIds)
    client.to(roomId).emit("bigBranchState", payload)
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
