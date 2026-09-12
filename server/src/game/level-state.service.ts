import { Injectable } from "@nestjs/common"
import { randomSeed } from "../../../shared/rng"
import {
  SHARED_LIGHT_DURATION_MS,
  SHARED_SPEED_BOOST_DURATION_MS,
  SHARED_LIGHT_RADIUS_BONUS,
  type BoostKind,
  type EnemyNetState,
  type RoomLevelState,
  type WaterSegmentState,
} from "../../../shared/game-protocol"

/**
 * Общий мир копания (уровни 0/1) одной комнаты — единственный источник
 * истины про: seed процедурной генерации текущего уровня, дифф уже
 * прогрызенных блоков, какие одноразовые предметы (звёзды/факел/пузырьки)
 * уже забраны, таймеры факела/буста скорости и последнее известное
 * состояние врагов. Уровни 2+ (бег муравья по поверхности) сюда не входят —
 * там нет ничего из перечисленного (см. комментарий в shared/game-protocol.ts).
 *
 * Отдельный от RoomService сервис — RoomService занимается только составом
 * комнаты (кто в ней, sessionId/reconnect), этот же — только игровым
 * состоянием ТЕКУЩЕГО общего уровня, тем же принципом разделения, что и у
 * GameService (позы) уже в проекте.
 */
@Injectable()
export class LevelStateService {
  private epochByRoom = new Map<string, number>()
  private teamStarsByRoom = new Map<string, number>()
  private levelByRoom = new Map<string, RoomLevelState | null>()

  // ---------------------------------------------------------------------
  // Уровни 3+ (жаба, вода) — см. комментарий у WaterSegmentState в
  // shared/game-protocol.ts. В отличие от levelByRoom выше (один слот на
  // комнату, перезаписывается целиком при каждом advance) — тут прогресс
  // независим на игрока, поэтому состояние копится ПО НОМЕРУ УРОВНЯ и
  // никогда не перезаписывается: два игрока комнаты вполне могут быть на
  // разных водных сегментах одновременно, и ни один не должен затирать
  // состояние другого.
  // ---------------------------------------------------------------------

  /** Ширина/высота всей водной фазы комнаты — фиксируется один раз (кто из
   * игроков первым запросил хоть один водный сегмент), как и
   * RoomLevelState.width/height для уровней 0/1. */
  private waterDimsByRoom = new Map<string, { width: number; height: number } | null>()
  /** roomId -> (номер уровня -> состояние этого сегмента). collectedItemIds/
   * keyFound/passageEntered актуальны только для level === 3 (см. комментарий
   * у WaterSegmentState в shared/game-protocol.ts) — для других номеров
   * (сейчас таких и не бывает) остаются в дефолте, безвредно. */
  private waterSegmentsByRoom = new Map<
    string,
    Map<number, { seed: number; collectedItemIds: string[]; keyFound: boolean; passageEntered: boolean }>
  >()

  public getEpoch(roomId: string): number {
    return this.epochByRoom.get(roomId) ?? 0
  }

  public getTeamStars(roomId: string): number {
    return this.teamStarsByRoom.get(roomId) ?? 0
  }

  public getLevelState(roomId: string): RoomLevelState | null {
    return this.levelByRoom.get(roomId) ?? null
  }

  private createFreshLevel(level: number, width: number, height: number): RoomLevelState {
    return {
      level,
      seed: randomSeed(),
      width,
      height,
      wallHits: {},
      collectedItemIds: [],
      lightEndsAt: 0,
      speedBoostEndsAt: 0,
      lightRadiusBonus: 0,
      enemies: [],
      materialCarriers: {},
      bridgeSlots: {},
      bigBranch: { progress: 0, carrierIds: [] },
    }
  }

  /**
   * "Дай текущее состояние level N, а если его ещё нет (свежая комната, никто
   * не заходил) — заведи новое с новым seed прямо сейчас". Первый вызов
   * (от того, кто первым дошёл до этого уровня) создаёт seed; второй —
   * получает УЖЕ существующее состояние, не переписывая его. Раз Node
   * однопоточный, гонки между двумя почти одновременными вызовами нет —
   * второй звонок гарантированно видит запись первого.
   */
  public ensureLevel(roomId: string, level: number, width: number, height: number): RoomLevelState {
    const existing = this.levelByRoom.get(roomId)
    if (existing && existing.level === level) return existing

    const fresh = this.createFreshLevel(level, width, height)
    this.levelByRoom.set(roomId, fresh)
    return fresh
  }

  /** Переводит ВСЮ комнату на следующий уровень — только если она всё ещё на
   * fromLevel (защита от повторной/устаревшей заявки на переход). */
  public advanceLevel(roomId: string, fromLevel: number, toLevel: number, width: number, height: number): RoomLevelState | null {
    const current = this.levelByRoom.get(roomId)
    if (!current || current.level !== fromLevel) return null

    const fresh = this.createFreshLevel(toLevel, width, height)
    this.levelByRoom.set(roomId, fresh)
    return fresh
  }

  /** Полный рестарт комнаты (кто-то погиб) — новая эпоха, обнулённый общий
   * счёт звёзд, свежий level 0 с новым seed. */
  public restartRoom(roomId: string, width: number, height: number): { levelState: RoomLevelState; teamStars: number; epoch: number } {
    const epoch = (this.epochByRoom.get(roomId) ?? 0) + 1
    this.epochByRoom.set(roomId, epoch)
    this.teamStarsByRoom.set(roomId, 0)

    const levelState = this.createFreshLevel(0, width, height)
    this.levelByRoom.set(roomId, levelState)

    return { levelState, teamStars: 0, epoch }
  }

  /** true, если удар записан (уровень актуален) — иначе клиент прислал
   * событие для уже неактуального (пройденного/перезапущенного) уровня. */
  public recordWallHit(roomId: string, level: number, cellKey: string, hits: number): boolean {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return false

    state.wallHits[cellKey] = hits
    return true
  }

  /** Засчитывает звезду в общий счёт команды — возвращает новый счёт, или
   * null, если эта звезда (по id) уже была засчитана раньше (анти-даблпик). */
  public collectStar(roomId: string, level: number, starId: string): number | null {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return null
    if (state.collectedItemIds.includes(starId)) return null

    state.collectedItemIds.push(starId)
    const teamStars = (this.teamStarsByRoom.get(roomId) ?? 0) + 1
    this.teamStarsByRoom.set(roomId, teamStars)
    return teamStars
  }

  /** Зажигает факел на весь уровень (для всей комнаты) — null, если уже
   * зажжён кем-то другим раньше (тот же switchId). */
  public activateLight(roomId: string, level: number, switchId: string): number | null {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return null
    if (state.collectedItemIds.includes(switchId)) return null

    state.collectedItemIds.push(switchId)
    state.lightEndsAt = Date.now() + SHARED_LIGHT_DURATION_MS
    return state.lightEndsAt
  }

  /** Пузырёк света/скорости — null, если этот конкретный (по id) уже собран. */
  public activateBoost(
    roomId: string,
    level: number,
    bubbleId: string,
    kind: BoostKind,
  ): { lightRadiusBonus: number; speedBoostEndsAt: number } | null {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return null
    if (state.collectedItemIds.includes(bubbleId)) return null

    state.collectedItemIds.push(bubbleId)
    if (kind === "light") {
      state.lightRadiusBonus += SHARED_LIGHT_RADIUS_BONUS
    } else {
      state.speedBoostEndsAt = Date.now() + SHARED_SPEED_BOOST_DURATION_MS
    }

    return { lightRadiusBonus: state.lightRadiusBonus, speedBoostEndsAt: state.speedBoostEndsAt }
  }

  /** Хост комнаты периодически шлёт сюда актуальное состояние врагов — сервер
   * только хранит последнее (для снапшота новому/переподключившемуся игроку),
   * саму симуляцию не пересчитывает (см. комментарий в EnemyWorm.ts). */
  public setEnemies(roomId: string, level: number, enemies: EnemyNetState[]): void {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return

    state.enemies = enemies
  }

  /** Уровень 2 (пруд/міст) — клеймить матеріал за гравцем: успіх, лише якщо
   * він ще нічий (не тримає інший гравець) і ще не встановлений у слот
   * назавжди. Той самий принцип "перший встиг", що і collectStar, тільки
   * клейм НЕ навічно (releaseMaterial знімає його при утопленні носія). */
  public grabMaterial(roomId: string, level: number, materialId: string, playerId: string): boolean {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return false
    if (state.materialCarriers[materialId]) return false
    if (Object.values(state.bridgeSlots).includes(materialId)) return false

    state.materialCarriers[materialId] = playerId
    return true
  }

  /** Носій утонув (або сам випустив матеріал) — знімає клейм, матеріал знову
   * вільний і видимий на своєму вихідному місці спавну (координати вже
   * детерміновані з seed на обох клієнтах, сервер їх не зберігає). */
  public releaseMaterial(roomId: string, level: number, materialId: string): void {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return

    delete state.materialCarriers[materialId]
  }

  /** Встановлює матеріал у слот моста назавжди — успіх, лише якщо саме цей
   * гравець зараз його несе і слот ще порожній. */
  public installMaterial(roomId: string, level: number, materialId: string, slotId: string, playerId: string): boolean {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return false
    if (state.materialCarriers[materialId] !== playerId) return false
    if (state.bridgeSlots[slotId]) return false

    delete state.materialCarriers[materialId]
    state.bridgeSlots[slotId] = materialId
    return true
  }

  /** Тільки хост кімнати реально рахує прогрес великої гілки (як enemies
   * вище) — сервер лише зберігає останнє відоме значення. */
  public setBigBranchState(roomId: string, level: number, progress: number, carrierIds: string[]): void {
    const state = this.levelByRoom.get(roomId)
    if (!state || state.level !== level) return

    state.bigBranch = { progress, carrierIds }
  }

  /**
   * "Дай канонический seed/размер водного сегмента level, а если для этого
   * номера уровня ещё никто не спрашивал — закрепи его прямо сейчас".
   * Ширина/высота фиксируются один раз на всю водную фазу комнаты (первым
   * вызовом с любым level >= 3); seed — свой для КАЖДОГО номера уровня, раз
   * игроки проходят их независимо и могут быть на разных сегментах сразу.
   * Node однопоточный — гонки между двумя почти одновременными вызовами нет
   * (тот же принцип, что и у ensureLevel).
   */
  public ensureWaterSegment(roomId: string, level: number, width: number, height: number): WaterSegmentState {
    let dims = this.waterDimsByRoom.get(roomId)
    if (!dims) {
      dims = { width, height }
      this.waterDimsByRoom.set(roomId, dims)
    }

    let segments = this.waterSegmentsByRoom.get(roomId)
    if (!segments) {
      segments = new Map()
      this.waterSegmentsByRoom.set(roomId, segments)
    }

    let segment = segments.get(level)
    if (!segment) {
      segment = { seed: randomSeed(), collectedItemIds: [], keyFound: false, passageEntered: false }
      segments.set(level, segment)
    }

    return {
      level,
      seed: segment.seed,
      width: dims.width,
      height: dims.height,
      collectedItemIds: segment.collectedItemIds,
      keyFound: segment.keyFound,
      passageEntered: segment.passageEntered,
    }
  }

  /** Текущее состояние сегмента level (кувшинки/ключ/проход) без побочного
   * создания — null, если для него ещё никто не звал ensureWaterSegment (см.
   * JoinRoomAck.waterLevelState — снапшот для нового/переподключившегося
   * игрока, "заводить" сегмент только ради чтения не нужно). */
  public getWaterSegmentState(roomId: string, level: number): WaterSegmentState | null {
    const dims = this.waterDimsByRoom.get(roomId)
    const segment = this.waterSegmentsByRoom.get(roomId)?.get(level)
    if (!dims || !segment) return null

    return {
      level,
      seed: segment.seed,
      width: dims.width,
      height: dims.height,
      collectedItemIds: segment.collectedItemIds,
      keyFound: segment.keyFound,
      passageEntered: segment.passageEntered,
    }
  }

  /** Уровень 3 — засчитывает подбор кувшинки/ключа: null, если этот itemId (по
   * id) уже был собран раньше (анти-даблпик, тот же принцип, что и
   * collectStar). Возвращает актуальное keyFound — важно даже для подбора
   * НЕ-ключа: клиент должен знать, найден ли ключ КЕМ-ТО ДРУГИМ, не только
   * этим конкретным событием. */
  public collectWaterItem(
    roomId: string,
    level: number,
    itemId: string,
    isKey: boolean,
  ): { collectedItemIds: string[]; keyFound: boolean } | null {
    const segment = this.waterSegmentsByRoom.get(roomId)?.get(level)
    if (!segment) return null
    if (segment.collectedItemIds.includes(itemId)) return null

    segment.collectedItemIds.push(itemId)
    if (isKey) segment.keyFound = true

    return { collectedItemIds: segment.collectedItemIds, keyFound: segment.keyFound }
  }

  /**
   * Уровень 3 — кто-то коснулся уже открытого прохода: null, если ключ ещё не
   * найден (клиент не должен был вообще прислать это событие — защита не
   * доверяет клиенту) или проход уже был пройден раньше (повторный вход не
   * создаёт уровень 4 заново, у комнаты он уже есть). При успехе — заводит
   * СВЕЖИЙ RoomLevelState уровня 4 (см. createFreshLevel) тем же способом,
   * что и обычный advanceLevel, только "из воды", а не из levelByRoom.
   */
  public enterWaterPassage(roomId: string, level: number, width: number, height: number): RoomLevelState | null {
    const segment = this.waterSegmentsByRoom.get(roomId)?.get(level)
    if (!segment || !segment.keyFound || segment.passageEntered) return null

    segment.passageEntered = true

    const levelState = this.createFreshLevel(4, width, height)
    this.levelByRoom.set(roomId, levelState)
    return levelState
  }

  public removeRoom(roomId: string): void {
    this.epochByRoom.delete(roomId)
    this.teamStarsByRoom.delete(roomId)
    this.levelByRoom.delete(roomId)
    this.waterDimsByRoom.delete(roomId)
    this.waterSegmentsByRoom.delete(roomId)
  }
}
