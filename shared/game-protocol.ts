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
// Общий мир копания (уровни 0/1) — карта, копание, враги, свет, звёзды.
//
// Уровни 2+ (бег муравья по поверхности) сюда не входят: там нет ни камня,
// ни звёзд, ни врагов (см. GameScene.generateNextLevel — при level > 1 весь
// этот спавн уже пропускается в самом клиенте), так что делить их между
// игроками просто нечего. Вся секция ниже — про то немногое, ЧТО РЕАЛЬНО
// нужно шарить: seed процедурной генерации (см. shared/rng.ts — оба клиента
// получают одно и то же число и генерируют побитово одинаковую карту сами,
// а не пересылают её целиком), диффы уже прогрызенных блоков, кто уже забрал
// одноразовые предметы (звёзды/пузырьки/факел) и состояние врагов.
// ---------------------------------------------------------------------------

/** Один вражеский червяк или страж — минимум, нужный, чтобы отрисовать его у
 * партнёра (не-хосту): позиция, поворот, жив ли, что несёт. */
export interface EnemyNetState {
  id: string
  kind: "enemy" | "guard"
  x: number
  y: number
  rotation: number
  alive: boolean
  /** id звезды, которую сейчас тащит (см. StarCollectedPayload.starId) — null, если ничего не несёт. */
  carryingStarId: string | null
}

/**
 * Полное состояние ТЕКУЩЕГО общего уровня комнаты (всегда level 0 или 1 —
 * следующего уровня, пока текущий не пройден оба сразу, попросту не
 * существует). Ровно это возвращается новому/переподключившемуся игроку —
 * "полный текущий снапшот комнаты", а не пустая карта с нуля.
 */
export interface RoomLevelState {
  level: number
  seed: number
  /** Ширина/высота уровня в мировых px — решается ОДИН раз, тем клиентом, чей
   * запрос (ensureLevel/advanceLevel/roomRestart) первым завёл это состояние
   * (обычно его собственный digLevelWidth()/digLevelHeight() — см. GameScene).
   * Второй клиент ОБЯЗАН сгенерировать уровень с ЭТИМИ размерами, даже если
   * его собственный viewport другого размера (иначе разъедутся сами мировые
   * координаты клеток — общий seed один в один совпадающую карту даёт только
   * при совпадающих границах генерации). */
  width: number
  height: number
  /** cellKey ("x:y" в мировых координатах, общих для всей комнаты — см.
   * GameScene.cellKey) -> сколько ударов по этому блоку уже засчитано.
   * Отсутствует в объекте — блок ещё цел (полная прочность). Это и есть
   * "дифф изменённых клеток", а не карта целиком. */
  wallHits: Record<string, number>
  /** id уже подобранных (кем угодно) одноразовых предметов ТЕКУЩЕГО уровня —
   * звёзды, факел, пузырьки. Общий Set для всех типов, раз у них одна и та
   * же семантика "первый забрал — предмет исчезает для всех". */
  collectedItemIds: string[]
  /** 0, если факел сейчас не горит; иначе abs. unix-время (мс) окончания —
   * оба клиента считают оставшееся время от него самостоятельно, без дрейфа. */
  lightEndsAt: number
  /** То же самое для пузырька скорости — 0, если буст сейчас неактивен. */
  speedBoostEndsAt: number
  /** Суммарная добавка к радиусу света от уже собранных пузырьков света —
   * в отличие от факела/скорости это не таймер, а постоянный бонус уровня. */
  lightRadiusBonus: number
  enemies: EnemyNetState[]
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
  /** Сколько раз комната была перезапущена целиком (см. RoomRestartPayload) —
   * растёт монотонно, используется, чтобы отличать актуальные широковещательные
   * события от устаревших (пришедших уже после следующего рестарта/перехода). */
  epoch?: number
  /** Общий счёт звёзд команды на момент входа — 0 для новой комнаты, иначе
   * актуальный счёт (см. StarCollectedPayload). */
  teamStars?: number
  /** Текущее состояние общего уровня (0/1) комнаты — null, если её ещё
   * никто не начал генерировать (самый первый вход в свежую комнату).
   * Это и есть "полный текущий снапшот" для новых/переподключившихся
   * игроков — им не нужно генерировать level 0 с нуля вслепую. */
  levelState?: RoomLevelState | null
}

export interface EnsureLevelPayload {
  roomId: string
  level: number
  /** Предлагаемые размеры (собственный digLevelWidth()/Height() отправителя) —
   * используются, только если для этого уровня ЕЩЁ нет состояния; иначе
   * сервер возвращает уже сохранённые (см. RoomLevelState.width/height). */
  width: number
  height: number
}

export interface EnsureLevelAck {
  ok: boolean
  levelState?: RoomLevelState
  teamStars?: number
  epoch?: number
}

export interface AdvanceLevelPayload {
  roomId: string
  fromLevel: number
  toLevel: number
  width: number
  height: number
}

export interface LevelAdvancedPayload {
  levelState: RoomLevelState
  teamStars: number
  epoch: number
}

export interface RoomRestartRequestPayload {
  roomId: string
  width: number
  height: number
}

export interface RoomRestartPayload {
  levelState: RoomLevelState
  teamStars: number
  epoch: number
}

export interface WallHitPayload {
  roomId: string
  level: number
  epoch: number
  cellKey: string
  hits: number
  destroyed: boolean
}

export interface WallUpdatedPayload {
  level: number
  epoch: number
  cellKey: string
  hits: number
  destroyed: boolean
}

export interface StarPickupPayload {
  roomId: string
  level: number
  epoch: number
  starId: string
}

export interface StarCollectedPayload {
  level: number
  epoch: number
  starId: string
  teamStars: number
}

export type BoostKind = "light" | "speed"

export interface LightActivatePayload {
  roomId: string
  level: number
  epoch: number
  switchId: string
}

export interface LightUpdatePayload {
  level: number
  epoch: number
  switchId: string
  lightEndsAt: number
}

export interface BoostActivatePayload {
  roomId: string
  level: number
  epoch: number
  bubbleId: string
  kind: BoostKind
}

export interface BoostUpdatePayload {
  level: number
  epoch: number
  bubbleId: string
  kind: BoostKind
  lightRadiusBonus: number
  speedBoostEndsAt: number
}

export interface EnemyStatePayload {
  roomId: string
  level: number
  epoch: number
  enemies: EnemyNetState[]
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

/**
 * Настоящая (уже посчитанная локально — с учётом стен/копания/травы) поза
 * игрока. В этой игре нельзя честно пересчитать движение авторитетно на
 * сервере — стены/уровень у каждого клиента свои процедурно сгенерированные,
 * сервер их не знает. Поэтому сервер тут не "физический авторитет", а просто
 * ретранслятор: держит последнюю присланную позу каждого игрока и рассылает
 * её остальным в комнате (см. GameService.setPose). PlayerInput/seq выше
 * оставлены как общая инфраструктура для generic-случая (если понадобится
 * честная server-side физика в другом режиме), но именно эту (совместную)
 * механику двигает playerPose.
 */
export interface PlayerPosePayload {
  x: number
  y: number
  form: PlayerForm
}

// ---------------------------------------------------------------------------
// Типизированные карты событий Socket.IO (в обе стороны)
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  joinRoom: (payload: JoinRoomPayload, ack: (response: JoinRoomAck) => void) => void
  playerInput: (payload: PlayerInput) => void
  playerPose: (payload: PlayerPosePayload) => void
  playerTransform: (payload: PlayerTransformPayload) => void
  levelComplete: (payload: LevelCompletePayload) => void
  leaveRoom: () => void
  // -- Общий мир копания (уровни 0/1), см. секцию RoomLevelState выше --
  /** "Дай мне текущее состояние level 0/1 комнаты, а если его ещё нет —
   * создай (с новым seed) прямо сейчас": первый вызов после joinRoom с
   * levelState === null, либо повторный при рассинхроне. */
  ensureLevel: (payload: EnsureLevelPayload, ack: (response: EnsureLevelAck) => void) => void
  /** Игрок дошёл до двери с полным набором звёзд команды — переводит ВСЮ
   * комнату на следующий уровень разом (см. LevelAdvancedPayload). */
  advanceLevel: (payload: AdvanceLevelPayload, ack: (response: EnsureLevelAck) => void) => void
  /** Игрок погиб — перезапускает общий уровень (новый seed, новая эпоха) для
   * ВСЕЙ комнаты, иначе карты игроков тут же разошлись бы. */
  roomRestart: (payload: RoomRestartRequestPayload) => void
  wallHit: (payload: WallHitPayload) => void
  starPickup: (payload: StarPickupPayload) => void
  lightActivate: (payload: LightActivatePayload) => void
  boostActivate: (payload: BoostActivatePayload) => void
  /** Периодически шлёт только "хост" комнаты (см. game/network — первый по
   * RoomInfo.players) — сервер лишь ретранслирует остальным, не пересчитывает. */
  enemyState: (payload: EnemyStatePayload) => void
}

export interface ServerToClientEvents {
  roomUpdated: (room: RoomInfo) => void
  stateSnapshot: (snapshot: GameStateSnapshot) => void
  playerTransform: (payload: PlayerTransformPayload) => void
  levelComplete: (payload: LevelCompletePayload) => void
  playerJoined: (payload: PlayerJoinedPayload) => void
  playerLeft: (payload: PlayerLeftPayload) => void
  errorMessage: (message: string) => void
  levelAdvanced: (payload: LevelAdvancedPayload) => void
  roomRestarted: (payload: RoomRestartPayload) => void
  wallUpdated: (payload: WallUpdatedPayload) => void
  starCollected: (payload: StarCollectedPayload) => void
  lightUpdate: (payload: LightUpdatePayload) => void
  boostUpdate: (payload: BoostUpdatePayload) => void
  enemyState: (payload: EnemyStatePayload) => void
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

// ---------------------------------------------------------------------------
// Тайминги/баланс общих (шарящихся между игроками комнаты) эффектов уровня —
// сервер авторитетно считает МОМЕНТ ОКОНЧАНИЯ по этим длительностям (см.
// RoomLevelState.lightEndsAt/speedBoostEndsAt), а не сами длительности,
// поэтому таймеры не расходятся между клиентами даже при задержке сети.
// Вынесены сюда (а не только в game/config/GameConfig.ts), потому что нужны
// и серверу (у него нет доступа к клиентским game/config/*) — GameConfig.ts
// переиспользует эти же константы для single player, чтобы баланс не разъехался.
// ---------------------------------------------------------------------------

/** Сколько миллисекунд действует факел-выключатель (карта видна без тумана). */
export const SHARED_LIGHT_DURATION_MS = 60_000

/** Сколько миллисекунд действует пузырёк скорости. */
export const SHARED_SPEED_BOOST_DURATION_MS = 15_000

/** Во сколько раз пузырёк скорости ускоряет игрока, пока действует. */
export const SHARED_SPEED_BOOST_MULTIPLIER = 2

/** Постоянная добавка к радиусу света от одного пузырька света. */
export const SHARED_LIGHT_RADIUS_BONUS = 45

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
