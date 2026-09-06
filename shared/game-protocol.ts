/**
 * Единый сетевой протокол между Next.js-клиентом (game/network/*) и
 * NestJS-сервером (server/src/game/*). Один файл, импортируемый ОБЕИМИ
 * сторонами напрямую (клиент — через "@/shared/game-protocol", сервер —
 * относительным путём) — это и есть "shared TypeScript types": если payload
 * события поменяется, TS не даст забыть поправить обе стороны сразу.
 */

export type GameMode = "solo" | "coop"

/** Форма игрока — от неё зависит скорость (см. PLAYER_SPEED_BY_FORM). */
export type PlayerForm = "worm" | "ant"

/**
 * Ввод одного игрока за один кадр — аналоговый вектор (как джойстик/WASD в
 * самой игре: game/input/InputManager.getAnalogVector), а не дискретные
 * "нажата/отпущена" события. seq — монотонно растущий номер конкретно ЭТОГО
 * игрока, на нём построены local prediction и reconciliation на клиенте.
 */
export interface PlayerInput {
  seq: number
  dx: number // [-1, 1]
  dy: number // [-1, 1]
  /** Клиентская метка времени — только для отладки/логов, не участвует в авторитетной логике. */
  timestamp: number
}

/** Авторитетное состояние одного игрока в конкретный момент. */
export interface PlayerState {
  playerId: string
  form: PlayerForm
  x: number
  y: number
  /** Последний seq инпута ЭТОГО игрока, который сервер уже учёл — по нему
   * клиент понимает, какие из своих локальных инпутов можно "простить"
   * (не переигрывать заново поверх нового снапшота). */
  lastProcessedSeq: number
}

/** Снапшот комнаты целиком — рассылается всем в комнате каждый тик GameLoopService. */
export interface GameStateSnapshot {
  roomId: string
  tick: number
  timestamp: number
  players: PlayerState[]
}

export interface RoomPlayerInfo {
  playerId: string
  sessionId: string
  connected: boolean
}

export interface RoomInfo {
  roomId: string
  mode: GameMode
  maxPlayers: number
  players: RoomPlayerInfo[]
}

// ---------------------------------------------------------------------------
// Payload'ы конкретных событий
// ---------------------------------------------------------------------------

export interface JoinRoomPayload {
  mode: GameMode
  /** Персистентный (localStorage) id клиента — по нему сервер узнаёт "это тот
   * же игрок" при reconnect, см. RoomService.joinRoom. */
  sessionId: string
  /** Явный roomId (например, из ссылки-приглашения) — необязателен, иначе
   * сервер сам ищет свободную комнату или создаёт новую (auto create/join). */
  roomId?: string
}

export interface JoinRoomAck {
  ok: boolean
  error?: string
  room?: RoomInfo
  playerId?: string
}

export interface PlayerTransformPayload {
  playerId: string
  form: PlayerForm
}

export interface LevelCompletePayload {
  roomId: string
  playerId: string
  levelIndex: number
}

export interface PlayerJoinedPayload {
  playerId: string
}

export interface PlayerLeftPayload {
  playerId: string
}

// ---------------------------------------------------------------------------
// Типизированные карты событий Socket.IO (в обе стороны)
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  joinRoom: (payload: JoinRoomPayload, ack: (response: JoinRoomAck) => void) => void
  playerInput: (payload: PlayerInput) => void
  playerTransform: (payload: PlayerTransformPayload) => void
  levelComplete: (payload: LevelCompletePayload) => void
  leaveRoom: () => void
}

export interface ServerToClientEvents {
  roomUpdated: (room: RoomInfo) => void
  stateSnapshot: (snapshot: GameStateSnapshot) => void
  playerTransform: (payload: PlayerTransformPayload) => void
  levelComplete: (payload: LevelCompletePayload) => void
  playerJoined: (payload: PlayerJoinedPayload) => void
  playerLeft: (payload: PlayerLeftPayload) => void
  errorMessage: (message: string) => void
}

// ---------------------------------------------------------------------------
// Константы баланса/тайминга — общие для сервера (авторитетная симуляция) и
// клиента (local prediction в co-op и единственная симуляция в single player)
// ---------------------------------------------------------------------------

/** Частота серверного игрового цикла (Гц) — используется и в GameLoopService
 * (сервер), и в GameNetworkStore (клиент — окно интерполяции удалённых игроков). */
export const SERVER_TICK_RATE = 20
export const SERVER_TICK_MS = 1000 / SERVER_TICK_RATE

export const MAX_PLAYERS_PER_ROOM = 2

/** Сколько мс отключившийся игрок держится в комнате "на паузе", прежде чем
 * будет вычищен окончательно — даёт время на reconnect по тому же sessionId. */
export const RECONNECT_GRACE_MS = 30_000

export const PLAYER_SPEED_BY_FORM: Record<PlayerForm, number> = {
  worm: 150,
  ant: 250,
}

/**
 * Один шаг интеграции позиции игрока по вводу — чистая функция без побочных
 * эффектов, поэтому безопасно шарится между сервером (авторитетная
 * симуляция в co-op) и клиентом (local prediction в co-op и единственная
 * симуляция в single player, где сервера вообще нет).
 */
export function stepPlayerState(state: PlayerState, input: Pick<PlayerInput, "dx" | "dy">, deltaSeconds: number): PlayerState {
  const speed = PLAYER_SPEED_BY_FORM[state.form]
  return {
    ...state,
    x: state.x + input.dx * speed * deltaSeconds,
    y: state.y + input.dy * speed * deltaSeconds,
  }
}

/** Создаёт начальное состояние свежего игрока (спавн в (0,0), форма — червяк). */
export function createInitialPlayerState(playerId: string, form: PlayerForm = "worm"): PlayerState {
  return { playerId, form, x: 0, y: 0, lastProcessedSeq: 0 }
}
