/**
 * Единый сетевой протокол между Next.js-клиентом (game/network/*) и
 * NestJS-сервером (server/src/game/*). Один файл, импортируемый ОБЕИМИ
 * сторонами напрямую (клиент — через "@/shared/game-protocol", сервер —
 * относительным путём) — это и есть "shared TypeScript types": если payload
 * события поменяется, TS не даст забыть поправить обе стороны сразу.
 */

export type GameMode = "solo" | "coop"

/** Форма игрока — от неё зависит скорость (см. PLAYER_SPEED_BY_FORM). */
export type PlayerForm = "worm" | "ant" | "frog"

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
// Общий мир копания и поверхности (уровни 0/1/2) — карта, копание, враги,
// свет, звёзды, а на уровне 2 ещё пруд/мост/матеріали (див. нижче).
//
// Уровни 3+ (жаба, вода) сюда не входят и генеруються локально, незалежно у
// кожного клієнта — це задокументоване обмеження (docs/network.md), поза
// межами шареного стану. Вся секция ниже — про то, ЧТО РЕАЛЬНО нужно шарить:
// seed процедурной генерации (см. shared/rng.ts — оба клиента получают одно
// и то же число и генерируют побитово одинаковую карту сами, а не пересылают
// её целиком), диффы уже прогрызенных блоков, кто уже забрал одноразовые
// предметы (звёзды/пузырьки/факел), состояние врагов, а для уровня 2 —
// матеріали в щелепах і зібрані секції мосту.
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
 * Полное состояние ТЕКУЩЕГО общего уровня комнаты (0, 1 или 2 — следующего
 * уровня, пока текущий не пройден оба сразу, попросту не существует). Ровно
 * это возвращается новому/переподключившемуся игроку — "полный текущий
 * снапшот комнаты", а не пустая карта с нуля.
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
  /**
   * Используются только когда level === 2 (уровень муравья с прудом/мостом —
   * см. GameScene.generateNextLevel) — для level 0/1 это всегда пустые
   * значения по умолчанию, как и enemies/wallHits для чужих типов уровня.
   *
   * materialCarriers: materialId ("2:material:i") -> playerId, который СЕЙЧАС
   * несёт этот материал в челюстях (запись отсутствует — материал свободен,
   * лежит на исходном месте спавна или уже установлен в слот). Это и есть
   * "клейм", не дающий двум игрокам подобрать один и тот же материал разом —
   * тот же принцип первого-успевшего, что и у collectedItemIds, только не
   * навсегда: при утоплении носителя клейм снимается (см. LevelStateService.releaseMaterial).
   */
  materialCarriers: Record<string, string>
  /** bridgeSlots: slotId ("2:slot:i") -> materialId, окончательно установленный
   * в этот слот моста (запись отсутствует — слот ещё пуст). В отличие от
   * materialCarriers это уже необратимо — слот не освобождается назад. */
  bridgeSlots: Record<string, string>
  /** Общий прогресс переноса большой ветки к финальному слоту (0..1, никогда
   * не сбрасывается назад) и id игроков, которые её сейчас толкают — считает
   * ТОЛЬКО хост комнаты (по тому же принципу, что и enemies выше), сервер
   * лишь хранит последнее известное значение. */
  bigBranch: { progress: number; carrierIds: string[] }
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
  /** Номер водного сегмента (уровень 3+), на котором ЭТОТ игрок сам был в
   * последний раз (по playerId, не по комнате — прогресс на воде у каждого
   * свой) — null/undefined, если он никогда не доплывал до воды. Позволяет
   * позднему присоединению/реконнекту сразу заспавниться жабой на нужном
   * сегменте, минуя кат-сцену метаморфозы (см. GameScene.startCoopLevel). */
  frogProgress?: number | null
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

export interface StarPickupAck {
  ok: boolean
  /** true — эту звезду только что забрал НЕ отправитель (кто-то другой в
   * комнате), не ошибка сама по себе, а нормальный исход гонки за одну
   * звезду (см. GameScene.tryPickupStar): звезда остаётся скрытой, но
   * локальный счёт этому игроку не начисляется. */
  alreadyCollected?: boolean
  /** Общий счёт команды на момент ответа — при ok:true совпадает с тем, что
   * придёт следующим же широковещательным starCollected (см. StarCollectedPayload),
   * а при alreadyCollected:true позволяет подтянуть актуальный счёт, даже
   * если широковещательное событие чужого подбора почему-то ещё не дошло. */
  teamStars?: number
  /** Причина отказа — "stale-level" (комната уже перешла на другой
   * уровень/эпоху, пока ответ шёл) или "not-in-room". Не используется для
   * alreadyCollected — там reason не нужен, это не ошибка. */
  reason?: string
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

// ---------------------------------------------------------------------------
// Уровни 3+ (жаба, вода) — в отличие от уровней 0/1/2 выше, тут НЕТ единого
// "текущего уровня комнаты": прогресс каждого игрока независим (никакой
// общей "двери", которую нужно проходить обоим сразу, тут не существует —
// каждый доплывает до края своего экрана и переходит на следующий сегмент
// сам, в своём темпе). Поэтому вместо одного replace-on-advance слота (как
// RoomLevelState) — независимое, растущее хранилище НА КАЖДЫЙ номер уровня:
// кто первый из игроков комнаты доплыл до сегмента N — тот и закрепляет его
// seed/размер (см. LevelStateService.ensureWaterSegment), второй игрок,
// доплыв туда позже (или после реконнекта), получает ТЕ ЖЕ значения, а не
// генерирует свои. Больше тут шарить нечего — на воде нет ни стен, ни
// звёзд, ни врагов.
// ---------------------------------------------------------------------------

/** Полное состояние одного водного сегмента (уровня 3+) — минимальный аналог
 * RoomLevelState для этой части игры. */
export interface WaterSegmentState {
  level: number
  seed: number
  /** Ширина/высота сегмента — решается ОДИН раз на всю водную фазу комнаты
   * (тем игроком, кто первым запросил хоть один водный сегмент), как и
   * RoomLevelState.width/height для уровней 0/1 — иначе разъедутся мировые
   * координаты между клиентами с разным размером экрана. */
  width: number
  height: number
}

export interface EnsureWaterSegmentPayload {
  roomId: string
  level: number
  width: number
  height: number
}

export interface EnsureWaterSegmentAck {
  ok: boolean
  segment?: WaterSegmentState
}

// ---------------------------------------------------------------------------
// Уровень 2 (муравей, пруд/міст) — матеріали в щелепах і велика гілка. Той
// самий "перший встиг — клеймить" принцип, що і starPickup/boostActivate
// вище, тільки клейм НЕ навічно (матеріал можна впустити при утопленні —
// див. materialRelease) — на відміну від collectedItemIds, що назавжди.
// ---------------------------------------------------------------------------

export interface MaterialGrabPayload {
  roomId: string
  level: number
  epoch: number
  materialId: string
}

export interface MaterialGrabAck {
  ok: boolean
}

export interface MaterialUpdatedPayload {
  level: number
  epoch: number
  materialId: string
  /** null — матеріал знову вільний (впав при утопленні носія), інакше — id
   * гравця, який щойно його підібрав. */
  carrierId: string | null
}

export interface MaterialInstallPayload {
  roomId: string
  level: number
  epoch: number
  materialId: string
  slotId: string
}

export interface MaterialInstallAck {
  ok: boolean
}

export interface SlotUpdatedPayload {
  level: number
  epoch: number
  slotId: string
  materialId: string
}

/** Тільки хост кімнати реально рахує/шле це (як enemyState) — сервер лише
 * зберігає останнє відоме значення для нового/перепідключеного гравця. */
export interface BigBranchStatePayload {
  roomId: string
  level: number
  epoch: number
  progress: number
  carrierIds: string[]
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
  starPickup: (payload: StarPickupPayload, ack: (response: StarPickupAck) => void) => void
  lightActivate: (payload: LightActivatePayload) => void
  boostActivate: (payload: BoostActivatePayload) => void
  /** Периодически шлёт только "хост" комнаты (см. game/network — первый по
   * RoomInfo.players) — сервер лишь ретранслирует остальным, не пересчитывает. */
  enemyState: (payload: EnemyStatePayload) => void
  // -- Уровень 2 (пруд/міст), див. секцію вище --
  materialGrab: (payload: MaterialGrabPayload, ack: (response: MaterialGrabAck) => void) => void
  materialRelease: (payload: MaterialGrabPayload) => void
  materialInstall: (payload: MaterialInstallPayload, ack: (response: MaterialInstallAck) => void) => void
  /** Шле лише хост (як enemyState) — сервер лише зберігає останнє значення. */
  bigBranchState: (payload: BigBranchStatePayload) => void
  // -- Уровни 3+ (жаба, вода), см. секцию WaterSegmentState выше --
  /** "Дай канонический seed/размер водного сегмента level, а если для него
   * ещё никто не спрашивал — закрепи мои предложенные width/height прямо
   * сейчас". В отличие от ensureLevel/advanceLevel — НЕ требует, чтобы вся
   * комната была на одном номере уровня: у каждого игрока свой независимый
   * прогресс по воде (см. LevelStateService.ensureWaterSegment). */
  ensureWaterSegment: (payload: EnsureWaterSegmentPayload, ack: (response: EnsureWaterSegmentAck) => void) => void
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
  materialUpdated: (payload: MaterialUpdatedPayload) => void
  slotUpdated: (payload: SlotUpdatedPayload) => void
  bigBranchState: (payload: BigBranchStatePayload) => void
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
  frog: 150,
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

/** Во сколько раз пузырёк скорости ускоряет игрока, пока действует. Раньше
 * было 2 (полное удвоение скорости) — многовато, снижено до 1.5. Длительность
 * эффекта (SHARED_SPEED_BOOST_DURATION_MS выше) при этом не менялась. */
export const SHARED_SPEED_BOOST_MULTIPLIER = 1.5

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
