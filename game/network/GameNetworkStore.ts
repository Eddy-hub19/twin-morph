import { GameSocket, type TypedGameSocket } from "./GameSocket"
import {
  SERVER_TICK_MS,
  SERVER_TICK_RATE,
  createInitialPlayerState,
  stepPlayerState,
  type GameMode,
  type GameStateSnapshot,
  type PlayerForm,
  type PlayerInput,
  type PlayerState,
  type RoomInfo,
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
        this.notify()
        resolve(ack.room)
      })
    })
  }

  private bindSocketListeners(socket: TypedGameSocket): void {
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
  }
}
