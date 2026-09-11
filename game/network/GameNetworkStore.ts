import { GameSocket, type TypedGameSocket } from "./GameSocket"
import {
  SERVER_TICK_MS,
  SERVER_TICK_RATE,
  createInitialPlayerState,
  stepPlayerState,
  type BigBranchStatePayload,
  type BoostKind,
  type BoostUpdatePayload,
  type EnemyNetState,
  type EnsureWaterSegmentAck,
  type GameMode,
  type GameStateSnapshot,
  type LevelAdvancedPayload,
  type LightUpdatePayload,
  type MaterialUpdatedPayload,
  type PlayerForm,
  type PlayerInput,
  type PlayerState,
  type RoomInfo,
  type RoomLevelState,
  type RoomRestartPayload,
  type SlotUpdatedPayload,
  type StarCollectedPayload,
  type WallUpdatedPayload,
  type WaterSegmentState,
} from "@/shared/game-protocol"

export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected"

export interface NetworkSnapshot {
  mode: GameMode | null
  connectionStatus: ConnectionStatus
  roomInfo: RoomInfo | null
  localPlayerId: string | null
}

interface RemoteBufferEntry {
  prev: PlayerState
  next: PlayerState
  prevAt: number
  nextAt: number
}

/** Тот же принцип буферизации, что и у RemoteBufferEntry выше, только per-enemy
 * (по EnemyNetState.id) — см. enemyBuffers/getInterpolatedEnemyStates. */
interface EnemyBufferEntry {
  prev: EnemyNetState
  next: EnemyNetState
  prevAt: number
  nextAt: number
}

type Listener = () => void

/**
 * Единственный источник истины по сетевому состоянию игрока (singleton —
 * тот же принцип, что и у GameSocket). Работает в двух режимах:
 *
 *  - solo:  сервера нет вообще. GameNetworkStore сам является "авторитетом" —
 *           каждый вызов update() сразу и без сети продвигает локальное
 *           состояние через тот же stepPlayerState, которым на сервере
 *           пользуется GameService. Со стороны вызывающего кода (GameScene)
 *           API идентично co-op — веткование по режиму спрятано тут.
 *
 *  - coop:  подключается через GameSocket, шлёт свой ввод на сервер (local
 *           prediction — применяется локально СРАЗУ, не дожидаясь ответа),
 *           и при получении stateSnapshot сверяет локального игрока с
 *           авторитетной позицией (reconciliation: обрезает подтверждённые
 *           инпуты по lastProcessedSeq и переигрывает поверх снапшота
 *           оставшиеся неподтверждённые), а для ВТОРОГО игрока в комнате —
 *           не предсказывает, а копит последние два снапшота и линейно
 *           интерполирует между ними (remote interpolation).
 */
export class GameNetworkStore {
  private static instance: GameNetworkStore | undefined

  public static getInstance(): GameNetworkStore {
    if (!GameNetworkStore.instance) {
      GameNetworkStore.instance = new GameNetworkStore()
    }
    return GameNetworkStore.instance
  }

  private mode: GameMode | null = null
  private connectionStatus: ConnectionStatus = "idle"
  private roomInfo: RoomInfo | null = null
  private localPlayerId: string | null = null
  private localState: PlayerState | null = null

  private socket: TypedGameSocket | null = null
  /** Какому именно физическому сокету уже привязаны слушатели (см.
   * bindSocketListeners) — GameSocket переиспользует один и тот же сокет
   * между вызовами startCoop()/disconnect() (leave+rejoin комнаты, retry
   * после ошибки), так что без этой отметки каждый повторный startCoop()
   * навешивал бы ещё один комплект из ~13 обработчиков поверх старых —
   * каждое реальное событие (stateSnapshot, wallUpdated...) начинало бы
   * обрабатываться N раз (не просто лишний CPU, а дублирование записи в
   * очереди типа wallUpdateQueue). НЕ сбрасывается в reset() — привязка
   * живёт по жизненному циклу сокета, а не сессии стора. */
  private listenersBoundFor: TypedGameSocket | null = null
  private hasJoinedBefore = false
  /** roomId, запрошенный при старте co-op (из ссылки-приглашения) — переиспользуется при reconnect. */
  private requestedRoomId: string | undefined

  private inputSeq = 0
  /** Инпуты локального игрока, которые ещё не подтверждены сервером (по seq) — используются для reconciliation. */
  private pendingInputs: PlayerInput[] = []
  private remoteBuffers = new Map<string, RemoteBufferEntry>()

  private lastInputSentAt = 0
  private readonly minInputIntervalMs = 1000 / SERVER_TICK_RATE
  private lastPoseSentAt = 0

  // Общий мир копания (уровни 0/1) — см. shared/game-protocol.ts:
  // RoomLevelState. epoch/teamStars/levelState приходят сначала в JoinRoomAck
  // (полный снапшот для нового/переподключившегося игрока), дальше держатся
  // в актуальном состоянии широковещательными событиями сервера. Очереди
  // (wallUpdates и т.п.) — тот же принцип "накопили за кадр, GameScene раз в
  // кадр вычерпывает" (drain*), что и remoteBuffers выше: явная защита от
  // повторной обработки одного и того же события.
  private epoch = 0
  private teamStars = 0
  private levelState: RoomLevelState | null = null
  private wallUpdateQueue: WallUpdatedPayload[] = []
  private starCollectedQueue: StarCollectedPayload[] = []
  private lightUpdateQueue: LightUpdatePayload[] = []
  private boostUpdateQueue: BoostUpdatePayload[] = []
  private materialUpdateQueue: MaterialUpdatedPayload[] = []
  private slotUpdateQueue: SlotUpdatedPayload[] = []
  private latestBigBranchState: BigBranchStatePayload | null = null
  /** Номер водного сегмента (уровень 3+), на котором ЭТОТ игрок сам был в
   * последний раз — из JoinRoomAck.frogProgress, см. shared/game-protocol.ts.
   * null, если он никогда не доплывал до воды. Только для late-join/reconnect
   * bootstrap (см. GameScene.startCoopLevel) — сама водная фаза (уровни 3+)
   * не имеет единого "текущего уровня комнаты", в отличие от levelState выше. */
  private frogProgress: number | null = null
  private pendingLevelAdvanced: LevelAdvancedPayload | null = null
  private pendingRoomRestart: RoomRestartPayload | null = null
  private latestEnemyState: EnemyNetState[] | null = null
  /** Буфер (prev/next снапшот + время получения) на каждого врага/стража,
   * см. getInterpolatedEnemyStates — тот же принцип, что и remoteBuffers
   * выше для игроков, устраняет ривки/телепортации у гостя между редкими
   * (раз в minEnemyStateIntervalMs) обновлениями от хоста. */
  private enemyBuffers = new Map<string, EnemyBufferEntry>()
  private lastEnemyStateSentAt = 0
  private readonly minEnemyStateIntervalMs = 150
  private lastBigBranchStateSentAt = 0

  private listeners = new Set<Listener>()
  private cachedSnapshot: NetworkSnapshot = this.computeSnapshot()

  private constructor() {}

  // -------------------------------------------------------------------------
  // Публичный pub-sub (для useGameSocket / useSyncExternalStore)
  // -------------------------------------------------------------------------

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public getSnapshot(): NetworkSnapshot {
    return this.cachedSnapshot
  }

  private notify(): void {
    this.cachedSnapshot = this.computeSnapshot()
    for (const listener of this.listeners) listener()
  }

  private computeSnapshot(): NetworkSnapshot {
    return {
      mode: this.mode,
      connectionStatus: this.connectionStatus,
      roomInfo: this.roomInfo,
      localPlayerId: this.localPlayerId,
    }
  }

  // -------------------------------------------------------------------------
  // Старт режима
  // -------------------------------------------------------------------------

  /** Single Player — без единого обращения к сокету, работает полностью локально. */
  public startSolo(initialForm: PlayerForm = "worm"): void {
    this.reset()
    this.mode = "solo"
    this.connectionStatus = "connected" // сети тут нет, но потребителю API не нужно знать разницу
    this.localPlayerId = "local"
    this.localState = createInitialPlayerState("local", initialForm)
    this.notify()
  }

  /**
   * Co-op 2 Players — подключается к NestJS-серверу. Без roomId сервер сам
   * находит свободную комнату или создаёт новую (auto create/join); с
   * roomId (например, из ссылки-приглашения — см. ModeSelect) пытается
   * присоединиться именно к ней, и только если она вдруг уже полна/не
   * существует — откатывается к обычному автопоиску (см. RoomService).
   */
  public async startCoop(roomId?: string): Promise<RoomInfo> {
    this.reset()
    this.mode = "coop"
    this.connectionStatus = "connecting"
    this.requestedRoomId = roomId
    this.notify()

    const socket = GameSocket.getInstance().connect()
    this.socket = socket
    this.bindSocketListeners(socket)

    const room = await this.joinRoomOnSocket(socket)
    this.hasJoinedBefore = true
    return room
  }

  private joinRoomOnSocket(socket: TypedGameSocket): Promise<RoomInfo> {
    const sessionId = GameSocket.getInstance().getSessionId()

    return new Promise((resolve, reject) => {
      socket.emit("joinRoom", { mode: "coop", sessionId, roomId: this.requestedRoomId }, (ack) => {
        if (!ack.ok || !ack.room || !ack.playerId) {
          this.connectionStatus = "disconnected"
          this.notify()
          reject(new Error(ack.error ?? "Не удалось подключиться к комнате"))
          return
        }

        this.roomInfo = ack.room
        this.localPlayerId = ack.playerId
        // При reconnect сервер пришлёт актуальную позицию следующим же
        // snapshot'ом (см. handleSnapshot) — здесь просто не остаёмся без
        // локального состояния до этого момента.
        this.localState = this.localState ?? createInitialPlayerState(ack.playerId, "worm")
        this.connectionStatus = "connected"

        // Общий мир копания — полный снапшот комнаты прямо в ack, см.
        // комментарий у JoinRoomAck.levelState в shared/game-protocol.ts.
        this.epoch = ack.epoch ?? 0
        this.teamStars = ack.teamStars ?? 0
        this.levelState = ack.levelState ?? null
        this.frogProgress = ack.frogProgress ?? null

        this.notify()
        resolve(ack.room)
      })
    })
  }

  private bindSocketListeners(socket: TypedGameSocket): void {
    // Тот же физический сокет уже получил свой комплект обработчиков раньше
    // (см. комментарий у listenersBoundFor) — не навешиваем ещё один поверх.
    if (this.listenersBoundFor === socket) return
    this.listenersBoundFor = socket

    socket.on("disconnect", () => {
      this.connectionStatus = "disconnected"
      this.notify()
    })

    socket.on("connect", () => {
      // socket.io сам восстанавливает транспорт (reconnection: true в
      // GameSocket), но сервер узнаёт нас только через новый joinRoom с тем
      // же sessionId — новый физический сокет для NestJS выглядит как новое
      // подключение, пока мы явно не назовём свой sessionId ещё раз.
      if (this.mode === "coop" && this.hasJoinedBefore) {
        this.connectionStatus = "connecting"
        this.notify()
        this.joinRoomOnSocket(socket).catch(() => {
          // Ошибка уже отражена в connectionStatus внутри joinRoomOnSocket.
        })
      }
    })

    socket.on("roomUpdated", (room) => {
      this.roomInfo = room
      this.notify()
    })

    socket.on("stateSnapshot", (snapshot) => this.handleSnapshot(snapshot))

    socket.on("playerJoined", () => this.notify())

    socket.on("playerLeft", (payload) => {
      this.remoteBuffers.delete(payload.playerId)
      this.notify()
    })

    socket.on("playerTransform", (payload) => {
      if (payload.playerId === this.localPlayerId) return
      const buffer = this.remoteBuffers.get(payload.playerId)
      if (buffer) {
        buffer.prev = { ...buffer.prev, form: payload.form }
        buffer.next = { ...buffer.next, form: payload.form }
      }
    })

    // Общий мир копания — см. shared/game-protocol.ts. Широковещательные
    // события (сервер — источник истины) просто копятся в очередях/полях,
    // GameScene вычерпывает их раз в кадр (drain*) — так же, как остальной
    // код этого класса уже делает с remoteBuffers/pendingInputs.
    socket.on("wallUpdated", (payload) => this.wallUpdateQueue.push(payload))
    socket.on("starCollected", (payload) => {
      this.teamStars = payload.teamStars
      this.starCollectedQueue.push(payload)
    })
    socket.on("lightUpdate", (payload) => this.lightUpdateQueue.push(payload))
    socket.on("boostUpdate", (payload) => this.boostUpdateQueue.push(payload))
    socket.on("materialUpdated", (payload) => this.materialUpdateQueue.push(payload))
    socket.on("slotUpdated", (payload) => this.slotUpdateQueue.push(payload))
    socket.on("bigBranchState", (payload) => {
      this.latestBigBranchState = payload
    })
    socket.on("enemyState", (payload) => {
      this.latestEnemyState = payload.enemies

      const now = typeof performance !== "undefined" ? performance.now() : Date.now()
      for (const state of payload.enemies) {
        const existing = this.enemyBuffers.get(state.id)
        this.enemyBuffers.set(state.id, {
          prev: existing?.next ?? state,
          next: state,
          prevAt: existing?.nextAt ?? now,
          nextAt: now,
        })
      }
    })
    socket.on("levelAdvanced", (payload) => {
      this.levelState = payload.levelState
      this.teamStars = payload.teamStars
      this.epoch = payload.epoch
      this.pendingLevelAdvanced = payload
      this.notify()
    })
    socket.on("roomRestarted", (payload) => {
      this.levelState = payload.levelState
      this.teamStars = payload.teamStars
      this.epoch = payload.epoch
      this.pendingRoomRestart = payload
      this.notify()
    })
  }

  // -------------------------------------------------------------------------
  // Игровой цикл: ввод -> local prediction -> (co-op) сеть -> рендер
  // -------------------------------------------------------------------------

  /**
   * Вызывается каждый кадр из игрового цикла с текущим аналоговым вектором
   * ввода (тем же форматом, что и InputManager.getAnalogVector). Возвращает
   * свежее состояние локального игрока, готовое для рендера в Pixi.
   */
  public update(deltaSeconds: number, input: { dx: number; dy: number }): PlayerState | null {
    if (!this.localState) return null

    this.inputSeq += 1
    const playerInput: PlayerInput = { seq: this.inputSeq, dx: input.dx, dy: input.dy, timestamp: Date.now() }

    // Local prediction — применяем немедленно, не дожидаясь сервера. В solo
    // это единственная симуляция вообще (авторитета кроме клиента нет), в
    // co-op — предсказание, которое reconciliation ниже держит honest.
    this.localState = stepPlayerState(this.localState, playerInput, deltaSeconds)

    if (this.mode === "coop") {
      this.pendingInputs.push(playerInput)
      if (this.pendingInputs.length > 256) this.pendingInputs.shift() // защита от утечки, если сервер долго не отвечает
      this.sendInputThrottled(playerInput)
    }

    this.notify()
    return this.localState
  }

  private sendInputThrottled(input: PlayerInput): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    if (now - this.lastInputSentAt < this.minInputIntervalMs) return

    this.lastInputSentAt = now
    this.socket?.emit("playerInput", input)
  }

  /**
   * Реальный путь синхронизации Twin Morph: GameScene вызывает это каждый
   * кадр С УЖЕ ПОСЧИТАННОЙ позицией своего Worm/Ant (учитывающей стены,
   * копание, линию травы — то, что stepPlayerState выше не знает и знать
   * не может, раз уровень у каждого клиента свой процедурно сгенерированный).
   * В отличие от update()/sendInputThrottled — тут нет ни local prediction,
   * ни seq: локальный игрок и так уже полностью авторитетен сам для себя,
   * серверу остаётся только держать и ретранслировать его позу остальным
   * (см. GameService.setPose на сервере).
   */
  public reportLocalPose(x: number, y: number, form: PlayerForm): void {
    if (!this.localState) return

    this.localState = { ...this.localState, x, y, form }
    if (this.mode !== "coop") return

    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    if (now - this.lastPoseSentAt < this.minInputIntervalMs) return

    this.lastPoseSentAt = now
    this.socket?.emit("playerPose", { x, y, form })
  }

  private handleSnapshot(snapshot: GameStateSnapshot): void {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now()

    for (const playerState of snapshot.players) {
      if (playerState.playerId === this.localPlayerId) {
        this.reconcileLocalPlayer(playerState)
      } else {
        this.bufferRemotePlayer(playerState, now)
      }
    }

    this.notify()
  }

  /** Server authoritative + reconciliation: берём позицию сервера и заново
   * проигрываем поверх неё инпуты, которые сервер ещё не подтвердил. */
  private reconcileLocalPlayer(authoritative: PlayerState): void {
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > authoritative.lastProcessedSeq)

    let reconciled = authoritative
    for (const input of this.pendingInputs) {
      reconciled = stepPlayerState(reconciled, input, SERVER_TICK_MS / 1000)
    }

    this.localState = reconciled
  }

  /** Remote interpolation buffer: держим последние два снапшота удалённого
   * игрока, рендерим между ними (см. getRemotePlayerStates). */
  private bufferRemotePlayer(state: PlayerState, now: number): void {
    const existing = this.remoteBuffers.get(state.playerId)
    this.remoteBuffers.set(state.playerId, {
      prev: existing?.next ?? state,
      next: state,
      prevAt: existing?.nextAt ?? now,
      nextAt: now,
    })
  }

  public getLocalPlayerState(): PlayerState | null {
    return this.localState
  }

  /** Интерполированные позиции удалённых игроков (пусто в single player). */
  public getRemotePlayerStates(): PlayerState[] {
    if (this.remoteBuffers.size === 0) return []

    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    // Рендерим удалённых игроков с небольшой задержкой (на длину одного
    // серверного тика) — тогда почти всегда есть ДВА реальных снапшота,
    // между которыми честно интерполировать, а не экстраполировать вслепую.
    const renderTime = now - SERVER_TICK_MS

    const result: PlayerState[] = []
    for (const buffer of this.remoteBuffers.values()) {
      const span = buffer.nextAt - buffer.prevAt
      const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - buffer.prevAt) / span)) : 1

      result.push({
        ...buffer.next,
        x: buffer.prev.x + (buffer.next.x - buffer.prev.x) * t,
        y: buffer.prev.y + (buffer.next.y - buffer.prev.y) * t,
      })
    }
    return result
  }

  // -------------------------------------------------------------------------
  // Форма игрока / завершение уровня — критические события co-op
  // -------------------------------------------------------------------------

  public setLocalForm(form: PlayerForm): void {
    if (!this.localState) return

    this.localState = { ...this.localState, form }

    if (this.mode === "coop" && this.localPlayerId) {
      this.socket?.emit("playerTransform", { playerId: this.localPlayerId, form })
    }

    this.notify()
  }

  public notifyLevelComplete(levelIndex: number): void {
    if (this.mode !== "coop" || !this.localPlayerId || !this.roomInfo) return
    this.socket?.emit("levelComplete", { roomId: this.roomInfo.roomId, playerId: this.localPlayerId, levelIndex })
  }

  // -------------------------------------------------------------------------
  // Общий мир копания (уровни 0/1) — см. shared/game-protocol.ts. В single
  // player весь этот раздел не задействуется: GameScene различает режим сам
  // (mode !== "coop") и генерирует уровень локально со случайным seed, как и
  // раньше — этот класс лишь не мешает, возвращая null/пропуская отправку.
  // -------------------------------------------------------------------------

  public getEpoch(): number {
    return this.epoch
  }

  public getTeamStars(): number {
    return this.teamStars
  }

  public getLevelState(): RoomLevelState | null {
    return this.levelState
  }

  /** Номер водного сегмента (уровень 3+), на котором ЭТОТ игрок сам был в
   * последний раз (см. JoinRoomAck.frogProgress) — null, если он никогда не
   * доплывал до воды. Только для late-join/reconnect bootstrap. */
  public getFrogProgress(): number | null {
    return this.frogProgress
  }

  /** "Хост" комнаты — первый по RoomInfo.players (общий для обоих клиентов
   * порядок, задаётся сервером) — только он реально симулирует врагов/стража
   * и шлёт их состояние остальным (см. sendEnemyState). В single player
   * всегда true (там нет "остальных", и семантика не важна). */
  public isHost(): boolean {
    if (this.mode !== "coop") return true
    const players = this.roomInfo?.players ?? []
    return players[0]?.playerId === this.localPlayerId
  }

  /** "Дай текущее состояние level N, а если его ещё нет — заведи новое (с
   * ЭТИМИ width/height — свой digLevelWidth()/Height(), см. GameScene)" —
   * первый вызов после входа в co-op (levelState из join ещё null) или при
   * ручной пересинхронизации. Возвращает null в single player. */
  public async ensureLevel(level: number, width: number, height: number): Promise<RoomLevelState | null> {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return null

    return new Promise((resolve) => {
      this.socket!.emit("ensureLevel", { roomId: this.roomInfo!.roomId, level, width, height }, (ack) => {
        if (!ack.ok || !ack.levelState) {
          resolve(null)
          return
        }
        this.levelState = ack.levelState
        this.teamStars = ack.teamStars ?? this.teamStars
        this.epoch = ack.epoch ?? this.epoch
        resolve(ack.levelState)
      })
    })
  }

  /** Уровни 3+ (жаба, вода) — тот же принцип, что и ensureLevel выше ("первый
   * доплывший до сегмента N закрепляет его seed/размер, остальные
   * перевикористовують те самые"), но БЕЗ требования, чтобы вся комната была
   * на одном номере уровня — прогресс на воде независим у каждого игрока
   * (см. WaterSegmentState в shared/game-protocol.ts). Возвращает null в
   * single player (нет сети) — вызывающий код (GameScene) тогда просто
   * использует собственный window.innerWidth/Height, как и раньше. */
  public async ensureWaterSegment(level: number, width: number, height: number): Promise<WaterSegmentState | null> {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return null

    return new Promise((resolve) => {
      this.socket!.emit("ensureWaterSegment", { roomId: this.roomInfo!.roomId, level, width, height }, (ack: EnsureWaterSegmentAck) => {
        resolve(ack.ok && ack.segment ? ack.segment : null)
      })
    })
  }

  /** Игрок дошёл до двери с полным общим счётом звёзд — просит сервер
   * перевести ВСЮ комнату на следующий уровень. Сам переход GameScene
   * выполняет не отсюда, а из drainLevelAdvanced() — событие приходит
   * ОБОИМ клиентам одинаково (включая заявителя), это и есть единая точка,
   * где оба реально генерируют новый уровень. В single player — no-op,
   * вызывающий код сам делает переход немедленно, без сервера. */
  public requestAdvanceLevel(fromLevel: number, toLevel: number, width: number, height: number): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return
    this.socket.emit("advanceLevel", { roomId: this.roomInfo.roomId, fromLevel, toLevel, width, height }, () => {
      // Результат неважен здесь — реальный переход придёт широковещательно
      // через "levelAdvanced" (см. drainLevelAdvanced), даже самому заявителю.
    })
  }

  /** Игрок погиб на общем уровне — просит сервер перезапустить ВСЮ комнату
   * (иначе карты разошлись бы). Как и с advanceLevel, реальный рестарт
   * GameScene выполняет из drainRoomRestart() — по широковещательному
   * событию, а не по этому вызову напрямую. */
  public requestRoomRestart(width: number, height: number): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return
    this.socket.emit("roomRestart", { roomId: this.roomInfo.roomId, width, height })
  }

  /** Локальный игрок прогрыз/повредил блок — сообщает остальным в комнате
   * (сервер хранит это как часть диффа для следующего снапшота). */
  public reportWallHit(level: number, cellKey: string, hits: number, destroyed: boolean): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return
    this.socket.emit("wallHit", { roomId: this.roomInfo.roomId, level, epoch: this.epoch, cellKey, hits, destroyed })
  }

  /** Локальный игрок подобрал звезду — сервер проверяет уникальность starId
   * (анти-даблпик) и, если она ещё не была засчитана, рассылает новый общий
   * счёт всей комнате (см. drainStarCollected). */
  public requestStarPickup(level: number, starId: string): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return
    this.socket.emit("starPickup", { roomId: this.roomInfo.roomId, level, epoch: this.epoch, starId })
  }

  /** Локальный игрок зажёг факел-выключатель — действует на всю комнату. */
  public requestLightActivate(level: number, switchId: string): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return
    this.socket.emit("lightActivate", { roomId: this.roomInfo.roomId, level, epoch: this.epoch, switchId })
  }

  /** Локальный игрок подобрал пузырёк (света или скорости) — действует на всю комнату. */
  public requestBoostActivate(level: number, bubbleId: string, kind: BoostKind): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return
    this.socket.emit("boostActivate", { roomId: this.roomInfo.roomId, level, epoch: this.epoch, bubbleId, kind })
  }

  /** Уровень 2 (пруд/мост): просит клеймить материал за собой — true/false
   * приходит асинхронно (ack), реальное отображение у ОБОИХ клиентов всё
   * равно идёт через drainMaterialUpdates (широковещательно, как starPickup).
   * В single player клейм не нужен (некому конкурировать) — возвращает true
   * сразу же, без сети. */
  public async requestMaterialGrab(level: number, materialId: string): Promise<boolean> {
    if (this.mode !== "coop") return true
    if (!this.socket || !this.roomInfo) return false

    return new Promise((resolve) => {
      this.socket!.emit("materialGrab", { roomId: this.roomInfo!.roomId, level, epoch: this.epoch, materialId }, (ack) => resolve(ack.ok))
    })
  }

  /** Носитель утонул/выпустил материал — снимает клейм на сервере, чтобы он
   * снова стал видимым/подбираемым у партнёра. */
  public requestMaterialRelease(level: number, materialId: string): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo) return
    this.socket.emit("materialRelease", { roomId: this.roomInfo.roomId, level, epoch: this.epoch, materialId })
  }

  /** Устанавливает материал, который сейчас несёт локальный игрок, в слот
   * моста — успех, только если клеймил именно он и слот ещё пуст. */
  public async requestMaterialInstall(level: number, materialId: string, slotId: string): Promise<boolean> {
    if (this.mode !== "coop") return true
    if (!this.socket || !this.roomInfo) return false

    return new Promise((resolve) => {
      this.socket!.emit("materialInstall", { roomId: this.roomInfo!.roomId, level, epoch: this.epoch, materialId, slotId }, (ack) => resolve(ack.ok))
    })
  }

  /** Только хост комнаты реально шлёт это (см. isHost) — тот же троттлинг
   * (minEnemyStateIntervalMs), что и у sendEnemyState, чтобы не заливать
   * сокет обновлениями каждый кадр. */
  public sendBigBranchState(level: number, progress: number, carrierIds: string[]): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo || !this.isHost()) return

    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    if (now - this.lastBigBranchStateSentAt < this.minEnemyStateIntervalMs) return

    this.lastBigBranchStateSentAt = now
    this.socket.emit("bigBranchState", { roomId: this.roomInfo.roomId, level, epoch: this.epoch, progress, carrierIds })
  }

  /** Последнее известное состояние большой ветки от хоста (для гостя) — null,
   * если ещё ничего не приходило. */
  public getLatestBigBranchState(): BigBranchStatePayload | null {
    return this.latestBigBranchState
  }

  /** Только хост комнаты реально шлёт это (см. isHost) — троттлинг тот же
   * принцип, что и у sendInputThrottled/reportLocalPose. */
  public sendEnemyState(level: number, enemies: EnemyNetState[]): void {
    if (this.mode !== "coop" || !this.socket || !this.roomInfo || !this.isHost()) return

    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    if (now - this.lastEnemyStateSentAt < this.minEnemyStateIntervalMs) return

    this.lastEnemyStateSentAt = now
    this.socket.emit("enemyState", { roomId: this.roomInfo.roomId, level, epoch: this.epoch, enemies })
  }

  /** Последнее известное состояние врагов от хоста (для гостя) — null, если
   * ничего ещё не приходило (например, только что переподключились). Сырое,
   * без интерполяции — для одноразового наложения при входе/reconnect (см.
   * GameScene.applyLevelDiff) используйте это, а для рендера КАЖДЫЙ кадр —
   * getInterpolatedEnemyStates() ниже, иначе враги дёргаются/телепортируются
   * между редкими обновлениями от хоста. */
  public getLatestEnemyState(): EnemyNetState[] | null {
    return this.latestEnemyState
  }

  /** Интерполированное между последними двумя снапшотами состояние каждого
   * врага/стража — тот же принцип, что и getRemotePlayerStates() для
   * игроков, только окно рендера берётся от интервала рассылки enemyState
   * (хост шлёт заметно реже тика сервера), а не от SERVER_TICK_MS. Без этого
   * гость видел бы врага прыгающим в новую точку раз в minEnemyStateIntervalMs
   * — те самые ривки/телепортации. Поворот интерполируется по кратчайшей
   * дуге (через atan2(sin,cos)), а не напрямую — иначе враг закручивался бы
   * "в длинную сторону" при переходе через границу ±π. */
  public getInterpolatedEnemyStates(): EnemyNetState[] {
    if (this.enemyBuffers.size === 0) return this.latestEnemyState ?? []

    const now = typeof performance !== "undefined" ? performance.now() : Date.now()
    const renderTime = now - this.minEnemyStateIntervalMs

    const result: EnemyNetState[] = []
    for (const buffer of this.enemyBuffers.values()) {
      const span = buffer.nextAt - buffer.prevAt
      const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - buffer.prevAt) / span)) : 1

      const rotationDiff = Math.atan2(Math.sin(buffer.next.rotation - buffer.prev.rotation), Math.cos(buffer.next.rotation - buffer.prev.rotation))

      result.push({
        ...buffer.next,
        x: buffer.prev.x + (buffer.next.x - buffer.prev.x) * t,
        y: buffer.prev.y + (buffer.next.y - buffer.prev.y) * t,
        rotation: buffer.prev.rotation + rotationDiff * t,
      })
    }
    return result
  }

  // Каждый drain* — "накопили за кадр(ы), вычерпали ровно один раз" — явная
  // защита от повторной обработки одного и того же события, см. комментарий
  // у полей очередей выше.

  public drainWallUpdates(): WallUpdatedPayload[] {
    const drained = this.wallUpdateQueue
    this.wallUpdateQueue = []
    return drained
  }

  public drainStarCollected(): StarCollectedPayload[] {
    const drained = this.starCollectedQueue
    this.starCollectedQueue = []
    return drained
  }

  public drainLightUpdates(): LightUpdatePayload[] {
    const drained = this.lightUpdateQueue
    this.lightUpdateQueue = []
    return drained
  }

  public drainBoostUpdates(): BoostUpdatePayload[] {
    const drained = this.boostUpdateQueue
    this.boostUpdateQueue = []
    return drained
  }

  public drainMaterialUpdates(): MaterialUpdatedPayload[] {
    const drained = this.materialUpdateQueue
    this.materialUpdateQueue = []
    return drained
  }

  public drainSlotUpdates(): SlotUpdatedPayload[] {
    const drained = this.slotUpdateQueue
    this.slotUpdateQueue = []
    return drained
  }

  public drainLevelAdvanced(): LevelAdvancedPayload | null {
    const drained = this.pendingLevelAdvanced
    this.pendingLevelAdvanced = null
    return drained
  }

  public drainRoomRestart(): RoomRestartPayload | null {
    const drained = this.pendingRoomRestart
    this.pendingRoomRestart = null
    return drained
  }

  // -------------------------------------------------------------------------
  // Завершение
  // -------------------------------------------------------------------------

  public disconnect(): void {
    if (this.mode === "coop") {
      this.socket?.emit("leaveRoom")
      GameSocket.getInstance().disconnect()
    }
    this.reset()
    this.notify()
  }

  private reset(): void {
    this.mode = null
    this.connectionStatus = "idle"
    this.roomInfo = null
    this.localPlayerId = null
    this.localState = null
    this.socket = null
    this.hasJoinedBefore = false
    this.requestedRoomId = undefined
    this.inputSeq = 0
    this.pendingInputs = []
    this.remoteBuffers.clear()
    this.lastInputSentAt = 0
    this.lastPoseSentAt = 0
    this.epoch = 0
    this.teamStars = 0
    this.levelState = null
    this.frogProgress = null
    this.wallUpdateQueue = []
    this.starCollectedQueue = []
    this.lightUpdateQueue = []
    this.boostUpdateQueue = []
    this.materialUpdateQueue = []
    this.slotUpdateQueue = []
    this.latestBigBranchState = null
    this.pendingLevelAdvanced = null
    this.pendingRoomRestart = null
    this.latestEnemyState = null
    this.enemyBuffers.clear()
    this.lastEnemyStateSentAt = 0
    this.lastBigBranchStateSentAt = 0
  }
}
