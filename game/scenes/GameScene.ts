import { Scene } from "./Scene"
import { Entity } from "../entities/Entity"
import { Worm } from "../entities/Worm"
import { Wall, findWallAt, isPointBlocked } from "../entities/Wall"
import { Star } from "../entities/Star"
import { Bubble } from "../entities/Bubble"
import { SpeedBubble } from "../entities/SpeedBubble"
import { RevealSwitch } from "../entities/RevealSwitch"
import { EnemyWorm } from "../entities/EnemyWorm"
import { GuardWorm } from "../entities/GuardWorm"
import { Nest } from "../entities/Nest"
import { Ant } from "../entities/Ant"
import { Frog } from "../entities/Frog"
import { SaveButton } from "../entities/SaveButton"
import { LevelDoorMarker } from "../entities/LevelDoorMarker"
import { Leaf } from "../entities/Leaf"
import { Puddle } from "../entities/Puddle"
import { Sky } from "../entities/Sky"
import { Water } from "../entities/Water"
import { GameNetworkStore } from "../network/GameNetworkStore"
import type { InputManager } from "../input/InputManager"
import type { EnemyNetState, LevelAdvancedPayload, PlayerForm, PlayerState, RoomLevelState, RoomRestartPayload } from "../../shared/game-protocol"
import type { PartnerRole } from "../entities/PlayerCosmetics"
import { createRng, type Rng } from "../../shared/rng"
import { Container, Graphics, Sprite, Text, TextStyle, Texture } from "pixi.js"
import {
  CELL_SIZE,
  GRASS_LINE_Y,
  STARTING_PIT_HALF_WIDTH,
  STARTING_PIT_DEPTH,
  LEVEL_DOOR_HALF_WIDTH,
  FIND_OPEN_SPOT_MAX_ATTEMPTS,
  STARS_PER_LEVEL,
  BUBBLES_PER_LEVEL,
  SPEED_BUBBLES_PER_LEVEL,
  SPEED_BOOST_MULTIPLIER,
  SPEED_BOOST_DURATION,
  ENEMIES_PER_LEVEL,
  TERRAIN_STONE_BASE_CHANCE,
  TERRAIN_STONE_HEIGHT_FACTOR,
  TERRAIN_ORE_CHANCE,
  WORM_CAMERA_FOLLOW_LERP,
  WORM_FOCUS_ZOOM_SCALE,
  DIG_LEVEL_HEIGHT_MULTIPLIER,
  MOBILE_DIG_LEVEL_EXTRA_MULTIPLIER,
  META_ZOOM_SCALE,
  ANT_FOCUS_ZOOM_SCALE,
  META_ZOOM_SPEED,
  TRANSFORM_DURATION,
  DEATH_RESTART_DELAY,
  FOG_BASE_LIGHT_RADIUS,
  FOG_LIGHT_RADIUS_PER_BUBBLE,
  FOG_SOFT_EDGE,
  FOG_SIZE_MULTIPLIER,
  REVEAL_DURATION,
  NEST_STORAGE_RADIUS,
  NEST_SCATTER_MIN,
  NEST_SCATTER_RANGE,
  STEAL_COOLDOWN_AFTER_DROP,
  ENEMY_NEST_SPAWN_RADIUS,
  LEVEL3_PUDDLE_COUNT,
  LEVEL3_LEAF_COUNT,
  PUDDLE_WIDTH,
  PUDDLE_HEIGHT,
  FROG_FOCUS_ZOOM_SCALE,
  FROG_EDGE_MARGIN,
  PARTNER_ARROW_MARGIN,
  PARTNER_ARROW_TOP_MARGIN,
  PARTNER_ARROW_SMOOTHING,
  PARTNER_ARROW_COLOR,
} from "../config/GameConfig"

// Ключ localStorage для сохранённого прогресса — пишется ТОЛЬКО когда
// муравей нажимает кнопку сохранения (SaveButton), не автоматически на
// переходах между уровнями (см. GameScene.saveLevelProgress/SaveButton).
const LEVEL_STORAGE_KEY = "twin-morph.levelIndex"

enum MetaState {
  NONE,
  ZOOM_IN,
  TRANSFORM,
  ZOOM_OUT,
  COMPLETE,
}

export class GameScene extends Scene {
  private entities: Entity[] = []

  private activePlayer!: any
  private deathTimer = 0

  // Co-op: напарник — точно такой же Worm/Ant, что и локальный игрок (не
  // отдельный "призрак"-класс), просто его позицией управляет не InputManager,
  // а сетевой снапшот (см. syncNetwork/GameNetworkStore.getRemotePlayerStates).
  // В single player этот стор всегда в режиме "solo", и вся секция ниже —
  // no-op (см. syncNetwork: ранний return, если mode !== "coop").
  private readonly network = GameNetworkStore.getInstance()
  private readonly remoteEntities = new Map<string, { entity: Worm | Ant; form: PlayerForm }>()
  // "Пустой" InputManager для сущностей напарника — их update() мы вообще не
  // вызываем (двигаем через setRemotePosition), но конструкторы Worm/Ant
  // требуют объект с этим интерфейсом; настоящий InputManager вешал бы
  // реальные обработчики window.addEventListener, что тут не нужно и вредно.
  private readonly dummyInput = {
    isDown: () => false,
    isJustPressed: () => false,
    getAnalogVector: () => null,
    setAnalogVector: () => {},
    clearAnalogVector: () => {},
    setKeyState: () => {},
    destroy: () => {},
  } as unknown as InputManager

  private worldContainer = new Container()

  // Камера во время копания плавно, с отставанием следует за червяком (на
  // любом устройстве — и на телефоне/планшете, и на десктопе). Она не
  // прыгает к цели мгновенно, а каждый кадр "догоняет" её — отсюда
  // ощущение медленного, плавного следования, а не жёсткой привязки.
  private readonly cameraFollowLerp = WORM_CAMERA_FOLLOW_LERP
  // Постоянный зум камеры, пока червяк копает — тот же принцип "фокуса", что
  // и у муравья (antFocusZoomScale), но скромнее: копать нужно точно видеть.
  private readonly wormFocusZoomScale = WORM_FOCUS_ZOOM_SCALE

  private currentLevelYOffset = 0
  // Горизонтальное смещение уровня — используется только начиная с уровня 2
  // (муравей бежит вправо по поверхности): в отличие от вертикальных
  // уровней (копаем вверх), тут камера едет вправо вслед за муравьём.
  private currentLevelXOffset = 0
  private cellSize = CELL_SIZE
  private levelIndex = 0

  private metaState = MetaState.NONE
  private metaTimer = 0
  private grassLineY = GRASS_LINE_Y
  // Пиковый зум во время самого превращения (короткая красная вспышка).
  private metaZoomScale = META_ZOOM_SCALE
  // Постоянный зум камеры, когда муравей уже ходит: фокус на нём держится
  // всё время (не сбрасывается обратно в 1, как раньше) — камера следует
  // за муравьём, пока он на поверхности.
  private antFocusZoomScale = ANT_FOCUS_ZOOM_SCALE
  // То же самое, но для жабы на уровне воды — скромнее ant-зума, чтобы был
  // виден простор вокруг в обе стороны (жаба плавает по обеим осям).
  private frogFocusZoomScale = FROG_FOCUS_ZOOM_SCALE

  private hudContainer = new Container()
  private starsText?: Text
  private hintText?: Text
  private revealText?: Text
  private leavesText?: Text
  private collectedStars = 0
  private totalStars = 0

  // Co-op: стрелка на краю экрана, указывающая направление на напарника,
  // когда его не видно в кадре (см. updatePartnerArrow). Экранная сущность
  // (живёт в this.container, не в worldContainer — не зумируется/не едет с
  // камерой), плавно доводится до цели каждый кадр, а не прыгает мгновенно.
  private partnerArrow = new Graphics()
  private partnerArrowAlpha = 0
  private partnerArrowAngle = 0
  private partnerArrowX = 0
  private partnerArrowY = 0
  // Сколько кусочков листа муравей несёт с собой — тратятся по одному на
  // каждую лужу, чтобы навести через неё мостик (см. Puddle/Leaf, уровень 3).
  private carriedLeaves = 0

  // Туман войны: вокруг червя — светлый круг, дальше — темнота. Копаем вслепую.
  private fogContainer = new Container()
  private fogSprite?: Sprite
  private fogSize = 3000
  private readonly baseLightRadius = FOG_BASE_LIGHT_RADIUS
  private lightRadius = this.baseLightRadius
  private readonly lightRadiusPerBubble = FOG_LIGHT_RADIUS_PER_BUBBLE
  private readonly lightSoftEdge = FOG_SOFT_EDGE

  // Факел-выключатель: подобрал — минуту вся карта видна без тумана.
  private readonly revealDuration = REVEAL_DURATION
  private revealTimer = 0

  // Пузырёк скорости: подобрал — на SPEED_BOOST_DURATION секунд вдвое
  // быстрее ходишь. speedText виден только пока действует (как revealText).
  private speedBoostTimer = 0
  private speedText?: Text

  // ---------------------------------------------------------------------
  // Co-op: общий мир копания (уровни 0/1) — см. shared/game-protocol.ts:
  // RoomLevelState. rng — детерминированный ГПСЧ (createRng), которым
  // сгенерирован ТЕКУЩИЙ уровень: в single player это просто Math.random
  // (никакого seed нет и не нужно), в co-op — mulberry32 от seed, общего с
  // партнёром, так что оба генерируют побитово одинаковую карту.
  // roomLevelWidth/Height — реальные размеры, из которых сгенерирован
  // текущий уровень 0/1 (в single player совпадают с digLevelWidth()/Height(),
  // в co-op — те, что первым закрепил в комнате тот, кто зашёл раньше, даже
  // если у второго игрока другой размер экрана — иначе разъедутся сами
  // мировые координаты клеток, и общий seed перестанет давать одинаковую карту).
  private rng: Rng = Math.random
  private roomLevelWidth = 0
  private roomLevelHeight = 0
  private roomEpoch = 0
  // true между requestAdvanceLevel() и приходом широковещательного
  // levelAdvanced — не даёт заявке дублироваться каждый кадр, пока игрок
  // стоит у двери и ждёт остальных.
  private pendingAdvanceLevel = false
  // Тот же принцип, только для рестарта комнаты после смерти.
  private pendingRoomRestart = false
  // Отслеживаем, что каждый вражеский червяк нёс В ПРОШЛЫЙ раз — нужно
  // только гостю, чтобы заметить момент "перестал нести" (украденную звезду
  // подобрали/донесли на стороне хоста) и снова показать звезду у себя (см.
  // applyEnemyNetStates) — сам гость эту логику не считает.
  private readonly lastCarriedStarByEnemy = new Map<string, string | null>()

  // Загружаем сохранённый уровень только один раз — при самом первом
  // onCreate() (настоящая загрузка страницы). Рестарт после смерти вызывает
  // onCreate() повторно на том же экземпляре сцены и должен по-прежнему
  // начинать с уровня 0 червяком, а не с сохранённого прогресса.
  private hasCheckedSavedProgress = false

  protected onCreate(): void {
    const isCoop = this.network.getSnapshot().mode === "coop"
    // Co-op: общий мир копания решает сервер (комната может быть уже в
    // разгаре у партнёра, или мы — переподключившийся игрок) — локальный
    // сохранённый прогресс (loadSavedLevel) тут не смотрим вообще, иначе
    // late-joiner начал бы со своей же старой локальной карты вместо
    // актуального общего состояния комнаты.
    const startLevel = isCoop ? 0 : this.hasCheckedSavedProgress ? 0 : this.loadSavedLevel()
    this.hasCheckedSavedProgress = true

    this.metaState = MetaState.NONE
    this.metaTimer = 0
    this.collectedStars = 0
    this.totalStars = 0
    this.carriedLeaves = 0
    this.lightRadius = this.baseLightRadius
    this.revealTimer = 0
    this.speedBoostTimer = 0
    this.pendingAdvanceLevel = false
    this.pendingRoomRestart = false
    this.lastCarriedStarByEnemy.clear()
    // Текст факела-выключателя переживал рестарт уровня: revealTimer тут
    // выше уже честно обнулён, но сам HUD-текст (тот же Text-объект, что и
    // до смерти) оставался видимым с застрявшим числом — updateReveal()
    // больше не трогает его, раз revealTimer <= 0, и счётчик "зависал"
    // навсегда, будто сломался (отсюда и жалоба "таймер лагает").
    if (this.revealText) this.revealText.visible = false
    if (this.leavesText) this.leavesText.visible = false
    if (this.speedText) this.speedText.visible = false
    this.worldContainer.scale.set(1)
    this.worldContainer.pivot.set(0, 0)

    this.container.addChild(this.worldContainer)

    this.setupFog()
    this.setupHud()

    if (isCoop) {
      // Асинхронный путь (ждём сервер) — детали в startCoopLevel(). Всё
      // остальное содержимое onCreate() ниже — единственный (синхронный)
      // путь single player, полностью без изменений в поведении.
      this.rng = Math.random
      this.startCoopLevel()
      return
    }

    this.rng = Math.random
    this.roomLevelWidth = this.digLevelWidth()
    this.roomLevelHeight = this.digLevelHeight()

    if (startLevel >= 1) {
      // Сохранение доступно только муравью, кнопкой (SaveButton) — значит,
      // если прогресс сохранён, начинать нужно сразу муравьём на
      // сохранённом уровне, а не заново копать червяком с нуля.
      this.levelIndex = startLevel
      // Единственный вертикальный переход (0→1) уже позади — сколько бы
      // горизонтальных уровней ни было пройдено дальше, Y-смещение всегда
      // равно ровно одной (увеличенной) высоте уровня копания.
      this.currentLevelYOffset = -this.digLevelHeight()
      // Уровень 1 — X-смещение 0, каждый следующий горизонтальный уровень
      // (2, 3, ...) сдвинут ещё на одну ширину экрана вправо — та же
      // прогрессия, что и при обычном переходе между ними.
      this.currentLevelXOffset = (startLevel - 1) * window.innerWidth

      this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)

      const antX = this.currentLevelXOffset + window.innerWidth / 2
      const antY = this.currentLevelYOffset + this.grassLineY - 6
      const ant = new Ant(this.input, antX, antY)
      this.activePlayer = ant
      this.addEntity(ant)

      this.worldContainer.scale.set(this.antFocusZoomScale)
      this.worldContainer.pivot.set(antX, antY)
      this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
    } else {
      this.levelIndex = 0
      this.currentLevelYOffset = 0
      this.currentLevelXOffset = 0
      this.worldContainer.position.set(0, 0)

      const worm = new Worm(this.input)
      this.activePlayer = worm

      worm.init().then(() => {
        this.activePlayer.container.x = window.innerWidth / 2
        // Уровень 0 теперь выше обычного экрана (digLevelHeight) — старт
        // по-прежнему у самого дна уровня, просто дно теперь ниже.
        this.activePlayer.container.y = this.digLevelHeight() - 80
        this.addEntity(this.activePlayer)

        // Ставим камеру сразу на червяка (а не на мировой (0,0)) — иначе
        // первый кадр показал бы приближённый вид угла карты, и только потом
        // камера "доехала" бы до самого червяка.
        this.worldContainer.scale.set(this.wormFocusZoomScale)
        this.worldContainer.pivot.set(this.activePlayer.container.x, this.activePlayer.container.y)
        this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
      })

      this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)
    }
  }

  /**
   * Co-op: узнаёт у сервера текущее состояние общего уровня (0 или 1) —
   * новую комнату заводит сама (levelState === null после join), в уже
   * идущую (late-joiner/reconnect) заходит с ЕЁ актуальным seed/диффом, а не
   * генерирует свежую карту с нуля. Единственный асинхронный путь во всём
   * onCreate() — single player (см. выше) целиком синхронный, как и раньше.
   */
  private async startCoopLevel(): Promise<void> {
    this.currentLevelXOffset = 0
    this.worldContainer.position.set(0, 0)

    let levelState = this.network.getLevelState()
    if (!levelState) {
      levelState = await this.network.ensureLevel(0, this.digLevelWidth(), this.digLevelHeight())
    }

    if (!levelState) {
      // Сеть подвела между joinRoom и этим моментом (например, отвалились
      // сразу после входа) — не блокируем игру навсегда, откатываемся к
      // обычной локальной генерации; как только соединение восстановится,
      // обычный reconnect (joinRoomOnSocket) сам пришлёт актуальный
      // levelState следующим join, и очередной restartLevel() его подхватит.
      this.rng = Math.random
      this.roomLevelWidth = this.digLevelWidth()
      this.roomLevelHeight = this.digLevelHeight()
      this.levelIndex = 0
      this.currentLevelYOffset = 0
      this.generateNextLevel(0, 0, 0)
      this.spawnWormAtLevelStart()
      return
    }

    this.prepareRoomLevel(levelState, this.network.getEpoch())
    this.currentLevelYOffset = this.levelIndex >= 1 ? -this.roomLevelHeight : 0

    if (this.levelIndex >= 1) {
      // Late-joiner застал партнёра уже на уровне 1 — сразу муравей на линии
      // травы, как и при обычном локальном "startLevel >= 1" (см. выше).
      this.generateNextLevel(0, this.currentLevelYOffset, this.levelIndex)
      this.applyLevelDiff(levelState)

      const antX = window.innerWidth / 2
      const antY = this.currentLevelYOffset + this.grassLineY - 6
      const ant = new Ant(this.input, antX, antY)
      this.activePlayer = ant
      this.addEntity(ant)

      this.worldContainer.scale.set(this.antFocusZoomScale)
      this.worldContainer.pivot.set(antX, antY)
      this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
    } else {
      this.generateNextLevel(0, 0, 0)
      this.applyLevelDiff(levelState)
      this.spawnWormAtLevelStart()
    }
  }

  /** Общая часть старта уровня 0 (co-op и сетевой фолбэк выше) — ставит
   * нового Worm на дно только что сгенерированного уровня. Асинхронно (ждёт
   * загрузку спрайта), как и в исходном single player коде. */
  private spawnWormAtLevelStart(): void {
    const worm = new Worm(this.input)
    this.activePlayer = worm

    worm.init().then(() => {
      this.activePlayer.container.x = window.innerWidth / 2
      this.activePlayer.container.y = this.currentLevelYOffset + this.roomLevelHeight - 80
      this.addEntity(this.activePlayer)

      this.worldContainer.scale.set(this.wormFocusZoomScale)
      this.worldContainer.pivot.set(this.activePlayer.container.x, this.activePlayer.container.y)
      this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
    })
  }

  /** Общая часть применения RoomLevelState — детерминированный RNG от seed +
   * ровно те размеры, из которых уровень уже сгенерирован у партнёра. */
  private prepareRoomLevel(levelState: RoomLevelState, epoch: number): void {
    this.rng = createRng(levelState.seed)
    this.roomLevelWidth = levelState.width
    this.roomLevelHeight = levelState.height
    this.roomEpoch = epoch
    this.levelIndex = levelState.level
  }

  /**
   * Накладывает уже накопленный диф общего уровня на только что
   * сгенерированную (из того же seed) карту: прогрызенные блоки, уже
   * забранные предметы, текущие таймеры факела/буста, последнее известное
   * состояние врагов (для гостя, если оно уже есть). Вызывается сразу после
   * generateNextLevel() — что для свежего входа/reconnect, что для
   * levelAdvanced.
   */
  private applyLevelDiff(levelState: RoomLevelState): void {
    const walls = this.entities.filter((e): e is Wall => e instanceof Wall)
    for (const [cellKey, hits] of Object.entries(levelState.wallHits)) {
      walls.find((w) => w.cellKey === cellKey)?.applyRemoteHits(hits)
    }

    if (levelState.collectedItemIds.length > 0) {
      const collectibles = this.entities.filter(
        (e): e is Star | Bubble | SpeedBubble | RevealSwitch =>
          e instanceof Star || e instanceof Bubble || e instanceof SpeedBubble || e instanceof RevealSwitch,
      )
      for (const id of levelState.collectedItemIds) {
        const item = collectibles.find((e) => e.id === id)
        if (item) item.container.visible = false
      }
    }

    this.lightRadius = this.baseLightRadius + levelState.lightRadiusBonus
    this.rebuildFogTexture()

    this.revealTimer = levelState.lightEndsAt > 0 ? Math.max(0, (levelState.lightEndsAt - Date.now()) / 1000) : 0
    if (this.revealText) {
      this.revealText.visible = this.revealTimer > 0
      this.revealText.text = `🔥 Карта видна: ${Math.ceil(this.revealTimer)}с`
    }

    this.speedBoostTimer = levelState.speedBoostEndsAt > 0 ? Math.max(0, (levelState.speedBoostEndsAt - Date.now()) / 1000) : 0

    if (!this.network.isHost() && levelState.enemies.length > 0) {
      this.applyEnemyNetStates(levelState.enemies)
    }

    this.updateHud()
  }

  /** Гость применяет состояние врагов, присланное хостом — вместо своего ИИ
   * (см. EnemyWorm.setRemoteState/GuardWorm.setRemoteState). */
  private applyEnemyNetStates(states: EnemyNetState[]): void {
    const enemies = this.entities.filter((e): e is EnemyWorm => e instanceof EnemyWorm)
    const guards = this.entities.filter((e): e is GuardWorm => e instanceof GuardWorm)
    const stars = this.entities.filter((e): e is Star => e instanceof Star)

    for (const state of states) {
      if (state.kind === "guard") {
        guards.find((g) => g.remoteId === state.id)?.setRemoteState(state)
        continue
      }

      enemies.find((e) => e.remoteId === state.id)?.setRemoteState(state)

      const prevCarried = this.lastCarriedStarByEnemy.get(state.id) ?? null
      this.lastCarriedStarByEnemy.set(state.id, state.carryingStarId)

      if (state.carryingStarId) {
        const star = stars.find((s) => s.id === state.carryingStarId)
        if (star) star.container.visible = false
      } else if (prevCarried) {
        // Только что перестал нести (подобрали обратно/донёс до домика на
        // стороне хоста) — показываем звезду снова у текущей позиции врага:
        // для доставки в домик это и есть фактическое место, для отбитой у
        // вора звезды — очень близко к месту падения.
        const star = stars.find((s) => s.id === prevCarried)
        if (star) {
          star.container.position.set(state.x, state.y)
          star.container.visible = true
        }
      }
    }
  }

  /** Оба игрока получили это широковещательно (включая того, кто дошёл до
   * двери и попросил переход) — единственная точка, где реально происходит
   * переход level 0 -> 1 в co-op (см. GameNetworkStore.requestAdvanceLevel). */
  private applyLevelAdvanced(payload: LevelAdvancedPayload): void {
    this.pendingAdvanceLevel = false

    if (this.levelIndex !== 0 || payload.levelState.level !== 1) {
      // Устаревшее/чужое событие (например, мы уже успели уйти дальше по
      // локальному прогрессу уровня 2+) — молча игнорируем.
      return
    }

    const previousHeight = this.roomLevelHeight

    // Тот же приём, что и в исходном локальном переходе: оставляем только
    // активного игрока и напарника, остальное (стены/предметы старого
    // level 0) регенерируется заново из нового seed.
    this.entities = this.entities.filter((entity) => entity === this.activePlayer || this.isRemoteEntity(entity))
    this.worldContainer.removeChildren()
    if (this.activePlayer) this.worldContainer.addChild(this.activePlayer.container)
    for (const remote of this.remoteEntities.values()) this.worldContainer.addChild(remote.entity.container)

    // Абсолютная позиция игрока НЕ меняется (та же дверь, тот же шов между
    // уровнями) — сдвигаем только систему координат уровня, как и раньше.
    this.currentLevelYOffset -= previousHeight
    this.prepareRoomLevel(payload.levelState, payload.epoch)

    this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)
    this.applyLevelDiff(payload.levelState)

    if (this.activePlayer) this.worldContainer.addChild(this.activePlayer.container)
  }

  /** Кто-то погиб на общем уровне — вся комната перезапускается разом
   * (иначе карты игроков тут же разошлись бы), см. GameNetworkStore.requestRoomRestart. */
  private applyRoomRestart(payload: RoomRestartPayload): void {
    this.roomEpoch = payload.epoch

    if (this.levelIndex > 1) {
      // Мы уже дальше по локальному (несинхронизируемому) прогрессу
      // уровня 2+ — рестарт партнёра на копании нас не трогает.
      this.pendingRoomRestart = false
      return
    }

    this.pendingRoomRestart = false
    this.deathTimer = 0
    // restartLevel() снова вызовет onCreate() -> startCoopLevel(), который
    // на этот раз сразу увидит уже обновлённый network.getLevelState() —
    // без лишнего round-trip.
    this.restartLevel()
  }

  /**
   * Раз в кадр разбирает всё, что накопилось от сервера по общему уровню:
   * чужие удары по стенам, засчитанные звёзды, факел/буст — каждый drain*
   * вычерпывает свою очередь РОВНО ОДИН РАЗ (см. GameNetworkStore), так что
   * повторно одно и то же событие тут не применится. Гостю дополнительно
   * каждый кадр подставляет последнее известное состояние врагов от хоста.
   */
  private processSharedLevelEvents(): void {
    const epoch = this.roomEpoch
    const level = this.levelIndex

    const wallUpdates = this.network.drainWallUpdates()
    if (wallUpdates.length > 0) {
      const walls = this.entities.filter((e): e is Wall => e instanceof Wall)
      for (const update of wallUpdates) {
        if (update.level !== level || update.epoch !== epoch) continue
        walls.find((w) => w.cellKey === update.cellKey)?.applyRemoteHits(update.hits)
      }
    }

    const starUpdates = this.network.drainStarCollected()
    if (starUpdates.length > 0) {
      const stars = this.entities.filter((e): e is Star => e instanceof Star)
      let anyApplied = false
      for (const update of starUpdates) {
        if (update.level !== level || update.epoch !== epoch) continue
        const star = stars.find((s) => s.id === update.starId)
        if (star) star.container.visible = false
        anyApplied = true
      }
      if (anyApplied) this.updateHud()
    }

    const lightUpdates = this.network.drainLightUpdates()
    if (lightUpdates.length > 0) {
      const switches = this.entities.filter((e): e is RevealSwitch => e instanceof RevealSwitch)
      for (const update of lightUpdates) {
        if (update.level !== level || update.epoch !== epoch) continue
        const revealSwitch = switches.find((s) => s.id === update.switchId)
        if (revealSwitch) revealSwitch.container.visible = false
        this.revealTimer = Math.max(0, (update.lightEndsAt - Date.now()) / 1000)
        if (this.revealText) {
          this.revealText.visible = this.revealTimer > 0
          this.revealText.text = `🔥 Карта видна: ${Math.ceil(this.revealTimer)}с`
        }
      }
    }

    const boostUpdates = this.network.drainBoostUpdates()
    if (boostUpdates.length > 0) {
      const bubbles = this.entities.filter((e): e is Bubble => e instanceof Bubble)
      const speedBubbles = this.entities.filter((e): e is SpeedBubble => e instanceof SpeedBubble)
      for (const update of boostUpdates) {
        if (update.level !== level || update.epoch !== epoch) continue

        if (update.kind === "light") {
          const bubble = bubbles.find((b) => b.id === update.bubbleId)
          if (bubble) bubble.container.visible = false
          this.lightRadius = this.baseLightRadius + update.lightRadiusBonus
          this.rebuildFogTexture()
        } else {
          const speedBubble = speedBubbles.find((b) => b.id === update.bubbleId)
          if (speedBubble) speedBubble.container.visible = false
          this.speedBoostTimer = Math.max(0, (update.speedBoostEndsAt - Date.now()) / 1000)
        }
      }
    }

    if (!this.network.isHost()) {
      const latest = this.network.getLatestEnemyState()
      if (latest) this.applyEnemyNetStates(latest)
    }
  }

  /** Читает сохранённый кнопкой уровень (0, если нет/повреждён/невалиден). */
  private loadSavedLevel(): number {
    try {
      const raw = window.localStorage.getItem(LEVEL_STORAGE_KEY)
      const parsed = raw === null ? 0 : Number.parseInt(raw, 10)
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : 0
    } catch {
      // localStorage может быть недоступен (приватный режим и т.п.) — тогда
      // просто всегда начинаем с нуля.
      return 0
    }
  }

  /** Сохраняет номер уровня — вызывается только из SaveButton.press(). */
  private saveLevelProgress(level: number): void {
    try {
      window.localStorage.setItem(LEVEL_STORAGE_KEY, String(level))
    } catch {
      // Недоступный localStorage не должен ломать игру — прогресс просто не сохранится.
    }
  }

  /**
   * Процедурная генерация карт под размеры экрана. `startX` ненулевой
   * только для горизонтальных уровней (2+, бег муравья вправо) — уровни 0/1
   * (копание) всегда начинаются от startX = 0.
   */
  private generateNextLevel(startX: number, startY: number, level: number): void {
    // Уровни 0/1 (подземное копание) теперь выше обычного экрана и (на
    // мобильных) ещё и шире — есть где копать, а не упираться в стены почти
    // сразу. Ширина level 0 и level 1 должна СОВПАДАТЬ (общий digLevelWidth) —
    // иначе не совпадут X-координаты дверного проёма между ними (см.
    // doorMinX/doorMaxX ниже). Уровней 2+ (горизонтальный бег муравья) это
    // не касается — их ширина завязана на фиксированный window.innerWidth в
    // переходе между сегментами (см. update()), трогать её нельзя.
    // roomLevelWidth/Height — не то же самое, что digLevelWidth()/Height()
    // напрямую: в single player они равны (см. onCreate), но в co-op это
    // размеры, УЖЕ закреплённые сервером для этой комнаты (см. prepareRoomLevel) —
    // могут отличаться от собственного viewport этого клиента, если партнёр
    // зашёл первым с другим размером экрана.
    const width = level <= 1 ? this.roomLevelWidth : window.innerWidth
    const height = level <= 1 ? this.roomLevelHeight : window.innerHeight

    // Дверной проём по центру, общий для потолка уровня 0 и пола уровня 1 —
    // одни и те же X-границы гарантируют, что проход между уровнями всегда
    // совпадает и никогда не оказывается перекрыт.
    const doorMinX = width / 2 - LEVEL_DOOR_HALF_WIDTH
    const doorMaxX = width / 2 + LEVEL_DOOR_HALF_WIDTH

    if (level === 0) {
      // Раньше весь верхний край уровня был просто открыт по всей ширине —
      // подняться наверх можно было где угодно, без всякого явного "выхода".
      // Теперь наверх ведёт только узкий дверной проём по центру (отмечен
      // LevelDoorMarker ниже), а остальной потолок — обычная закрытая стена.
      for (let x = startX; x < startX + width + this.cellSize; x += this.cellSize) {
        // Крайний левый/правый столбец — сплошная стена из камня на всю
        // высоту уровня: камень не прогрызается (в отличие от руды/дирта) и
        // мгновенно убивает при касании (см. Worm.update), так что дальше
        // него никак не пройти и не выйти за пределы карты сбоку.
        const isEdgeColumn = x <= startX || x >= startX + width - this.cellSize

        for (let y = startY; y < startY + height; y += this.cellSize) {
          const localY = y - startY

          // Самый нижний ряд запечатан ВСЕГДА, даже под стартовой ямой —
          // раньше проверка ямы шла первой и глушила эту стену прямо под
          // собой, так что прокопать яму до дна означало провалиться за
          // пределы карты в пустоту. Теперь дно проверяем первым делом.
          const cellKey = `0:${x}:${y}`

          if (localY >= height - this.cellSize) {
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "bedrock", cellKey))
            continue
          }

          if (
            x > width / 2 - STARTING_PIT_HALF_WIDTH &&
            x < width / 2 + STARTING_PIT_HALF_WIDTH &&
            y > height - STARTING_PIT_DEPTH
          ) {
            continue
          }

          if (localY <= this.cellSize && x > doorMinX && x < doorMaxX) {
            continue
          }

          if (isEdgeColumn) {
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "stone", cellKey))
            continue
          }

          // Яма и дверь — тот же X-диапазон (оба по 80px от центра), то есть
          // уже выровнены друг под другом. Гарантируем, что именно в этой
          // колонке никогда не выпадет смертельный камень — без этого
          // рандомная полоса камня могла наглухо запечатать проход от старта
          // до двери (единственного выхода наверх), и уровень становился не
          // пройти в принципе. Руда/дирт по-прежнему могут тут выпасть —
          // сложность из "надо прокопать" никуда не делась, просто без риска
          // мгновенной смерти на единственном маршруте. Сложность камня
          // везде за пределами этой колонки не меняется.
          const isGuaranteedSafeColumn = x > doorMinX && x < doorMaxX

          const heightFactor = (height - localY) / height
          const stoneChance = isGuaranteedSafeColumn ? 0 : TERRAIN_STONE_BASE_CHANCE + TERRAIN_STONE_HEIGHT_FACTOR * heightFactor
          const oreChance = TERRAIN_ORE_CHANCE
          const roll = this.rng()
          const type = roll < stoneChance ? "stone" : roll < stoneChance + oreChance ? "ore" : "dirt"

          this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, type, cellKey))
        }
      }

      this.addEntity(new LevelDoorMarker(startX + width / 2, startY + this.cellSize - 20, "⬆ Уровень 2"))
    } else if (level === 1) {
      // Небо над травой раньше было просто пустотой — сквозь неё был виден
      // чёрный фон страницы, теперь там голубой задник с облаками (Sky —
      // чисто декоративная сущность, ни с чем не сталкивается).
      this.addEntity(new Sky(startX, startY, width, this.grassLineY))

      for (let x = startX; x < startX + width + this.cellSize; x += this.cellSize) {
        // Тот же сплошной, смертельный камень по бокам, что и на уровне 0 —
        // только ниже линии травы (сам подкопанный слой), сверху её трогать
        // незачем: муравей там не копает и со стенами не сталкивается.
        const isEdgeColumn = x <= startX || x >= startX + width - this.cellSize

        for (let y = startY; y < startY + height; y += this.cellSize) {
          const localY = y - startY
          const cellKey = `1:${x}:${y}`

          if (localY < this.grassLineY) continue

          if (localY === this.grassLineY) {
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "grass", cellKey))
            continue
          }

          if (isEdgeColumn) {
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "stone", cellKey))
            continue
          }

          if (localY >= height - this.cellSize * 2) {
            // Раньше тут была обычная (прогрызаемая) земля — из-за этого
            // можно было прокопать дно уровня 1 и провалиться в остатки
            // уровня 0 под ним, а граница между уровнями никак не была
            // видна. Бедрок решает оба: неразрушим и явно выделяется
            // цветом/полосами как настоящая граница уровня.
            //
            // НО: ровно под дверным проёмом (doorMinX/doorMaxX — тем же, что
            // и в потолке уровня 0 выше) проход обязан остаться открытым —
            // иначе червяк, только что поднявшийся из уровня 0 через эту же
            // дверь, упирается в сплошной бедрок и не может попасть в
            // уровень 1 вообще.
            if (x > doorMinX && x < doorMaxX) {
              continue
            }

            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "bedrock", cellKey))
            continue
          }

          // Тот же гарантированно безопасный (без камня) коридор, что и на
          // уровне 0, и по тому же X-диапазону — червяк поднимается из
          // уровня 0 именно в эту колонку (см. проход в полу выше), так что
          // именно здесь стена из камня чаще всего и запирала бы его сразу
          // на входе в уровень 1, ещё до того, как он успел куда-то отойти.
          const isGuaranteedSafeColumn = x > doorMinX && x < doorMaxX

          const sandRoll = this.rng()
          const stoneChance = isGuaranteedSafeColumn ? 0 : TERRAIN_STONE_BASE_CHANCE
          const type = sandRoll < stoneChance ? "stone" : sandRoll < stoneChance + TERRAIN_ORE_CHANCE ? "ore" : "sand"
          this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, type, cellKey))
        }
      }
    } else if (level === 2) {
      // Уровень 3 (индекс 2) — открытая поверхность, продолжение уровня 1
      // вправо: та же линия травы на той же высоте, голубое небо с облаками
      // вместо пустоты. Из препятствий — лужи прямо в линии травы: муравей
      // не проходит сквозь них, пока не наведёт мостик из подобранного по
      // пути листа (Leaf/Puddle, см. GameScene.update). В отличие от уровня
      // 4+ ниже, тут муравей ещё муравей — он проходит метаморфозу в жабу
      // только у ПРАВОГО края этого уровня (см. update()).
      this.addEntity(new Sky(startX, startY, width, this.grassLineY))

      // Лужи стоят равномерно по сегменту (примерно на 1/3 и 2/3 ширины) —
      // подальше от краёв и от кнопки сохранения посередине.
      const puddleSpacing = width / (LEVEL3_PUDDLE_COUNT + 1)
      const puddleLefts: number[] = []
      for (let i = 0; i < LEVEL3_PUDDLE_COUNT; i++) {
        const centerX = startX + puddleSpacing * (i + 1)
        puddleLefts.push(centerX - PUDDLE_WIDTH / 2)
      }
      const isInsidePuddle = (x: number) => puddleLefts.some((left) => x >= left && x < left + PUDDLE_WIDTH)

      for (let x = startX; x < startX + width + this.cellSize; x += this.cellSize) {
        // Клетки травы под будущей лужей не рисуем — саму лужу ставим поверх
        // отдельно ниже, одной сущностью на всю её ширину, а не по клеткам.
        if (!isInsidePuddle(x)) {
          this.addEntity(new Wall(x, startY + this.grassLineY, this.cellSize, this.cellSize, "grass"))
        }

        for (let y = startY + this.grassLineY + this.cellSize; y < startY + height; y += this.cellSize) {
          this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "dirt"))
        }
      }

      for (const left of puddleLefts) {
        this.addEntity(new Puddle(left, startY + this.grassLineY, PUDDLE_WIDTH, PUDDLE_HEIGHT))
      }

      // Кусочки листа разбросаны по всему сегменту, с запасом — луж всего
      // LEVEL3_PUDDLE_COUNT штук, а листьев заметно больше.
      for (let i = 0; i < LEVEL3_LEAF_COUNT; i++) {
        const leafX = startX + 60 + Math.random() * (width - 120)
        this.addEntity(new Leaf(leafX, startY + this.grassLineY - 16))
      }
    } else if (level >= 3) {
      // Уровень 4 (индекс 3) и дальше — водоём: муравей уже прошёл
      // метаморфозу в жабу на правом краю уровня 3 (см. update()), и весь
      // сегмент теперь целиком залит водой сверху донизу (Water — не только
      // над травой, как Sky, а во всю высоту) — жаба плавает по всей этой
      // толще, а не идёт по одной линии, как муравей.
      this.addEntity(new Water(startX, startY, width, height))
    }

    // Кнопка сохранения — только на уровнях 1/2 (там, где ходит муравей по
    // траве), одна на сегмент, чуть выше линии травы. На уровне 4+ (вода)
    // травы и опоры под ногами больше нет вообще — кнопке негде стоять.
    if (level === 1 || level === 2) {
      this.addEntity(new SaveButton(startX + width / 2, startY + this.grassLineY - 6))
    }

    // Видимые границы сегмента — раньше муравья просто держали невидимые
    // координатные рамки (minX/maxX в update()), без всякой видимой стены, и
    // было непонятно, почему он вдруг перестаёт идти дальше. Ставим
    // настоящую (бедрок — та же "предупреждающая лента", что и на границах
    // уровня 0/1) стену по обеим сторонам сегмента — Ant/Frog не проверяют
    // столкновения со стенами, так что это чисто визуальный ориентир,
    // реальную границу по-прежнему считает GameScene.update(). Левый край
    // закрыт всегда — возвращаться в начало сегмента незачем. Правый край НЕ
    // закрываем ни на уровне 1 (там переход на уровень 2), ни на уровне 2
    // (там метаморфоза в жабу и переход на уровень 4) — оба раза дальше есть
    // куда идти.
    if (level === 1 || level === 2) {
      // Уровни 1/2 (муравей, поверхность с травой) — стена только от неба до
      // травы, не включая её саму: там уже стоит "grass" на всю ширину
      // сегмента, дублировать/перекрывать эту клетку не надо.
      const addBoundaryColumn = (columnX: number) => {
        for (let y = startY; y < startY + this.grassLineY; y += this.cellSize) {
          this.addEntity(new Wall(columnX, y, this.cellSize, this.cellSize, "bedrock"))
        }
      }

      addBoundaryColumn(startX)
    } else if (level >= 3) {
      // Уровни 4+ (жаба, вода) — сегмент залит целиком, поэтому и граница
      // идёт от самого верха до самого низа, а не только до линии травы.
      // Правый край не закрываем нигде — там всегда переход в следующий
      // (тоже водный) сегмент.
      for (let y = startY; y < startY + height; y += this.cellSize) {
        this.addEntity(new Wall(startX, y, this.cellSize, this.cellSize, "bedrock"))
      }
    }

    // Звёзды, пузырьки, факел, домик воров и стражи — часть механики копания
    // (уровни 0/1). На горизонтальном уровне-беге (2+) муравей ничего из
    // этого не собирает и ни с кем не сталкивается, так что не спавним.
    if (level > 1) {
      this.updateHud()
      return
    }

    // Звёзды должны появляться только там, где вообще есть земля для копания:
    // на уровне 1 это песок между линией травы и нижним слоем плотной земли,
    // а не пустое небо над травой.
    const starLocalYMin = level === 1 ? this.grassLineY + this.cellSize : 80
    const starLocalYMax = level === 1 ? height - this.cellSize * 3 : height - 120
    const starLocalYRange = Math.max(starLocalYMax - starLocalYMin, 1)

    // levelWalls нужен уже здесь (не только ниже для норы/врагов) — звёзды/
    // пузырьки/факел лежат буквально закопанными в грунт (это нормально, их
    // и предстоит откопать), но НЕ должны попасть в камень или бедрок: камень
    // убивает при касании, а бедрок вообще не прогрызается — предмет там
    // либо недостижим, либо достаётся только ценой смерти.
    const levelWalls = this.entities.filter((e): e is Wall => e instanceof Wall)
    const isInsideImpassableWall = (x: number, y: number): boolean => {
      const type = findWallAt(levelWalls, x, y)?.type
      return type === "stone" || type === "bedrock"
    }
    const findSafeItemSpot = (): { x: number; y: number } => {
      let x = startX + this.rng() * (width - 100) + 50
      let y = startY + starLocalYMin + this.rng() * starLocalYRange

      for (let attempt = 0; attempt < FIND_OPEN_SPOT_MAX_ATTEMPTS; attempt++) {
        if (!isInsideImpassableWall(x, y)) break
        x = startX + this.rng() * (width - 100) + 50
        y = startY + starLocalYMin + this.rng() * starLocalYRange
      }

      return { x, y }
    }

    // id ("level:star:i" и т.п.) — одинаковый на обоих клиентах, раз оба
    // генерируют предметы в одном и том же порядке из общего seed (см.
    // Star.id/GameScene.reportStarPickup/RoomLevelState.collectedItemIds).
    for (let i = 0; i < STARS_PER_LEVEL; i++) {
      const spot = findSafeItemSpot()
      this.addEntity(new Star(spot.x, spot.y, `${level}:star:${i}`))
      this.totalStars++
    }

    // Пузырьки света — та же зона, что и звёзды (только там, где есть земля
    // для копания), но их всего 3: это редкий бонус на уровень.
    for (let i = 0; i < BUBBLES_PER_LEVEL; i++) {
      const spot = findSafeItemSpot()
      this.addEntity(new Bubble(spot.x, spot.y, `${level}:bubble:${i}`))
    }

    // Пузырьки скорости — отдельный от света бонус: на время удваивают
    // скорость ОБОИХ игроков комнаты (см. RoomLevelState.speedBoostEndsAt).
    for (let i = 0; i < SPEED_BUBBLES_PER_LEVEL; i++) {
      const spot = findSafeItemSpot()
      this.addEntity(new SpeedBubble(spot.x, spot.y, `${level}:speed:${i}`))
    }

    // Факел-выключатель — один на уровень: подобрал — минуту видно всю
    // карту без тумана войны.
    {
      const spot = findSafeItemSpot()
      this.addEntity(new RevealSwitch(spot.x, spot.y, `${level}:switch`))
    }

    // Вражеские червяки и их домик ходят/стоят только по уже открытым (не
    // занятым стеной) клеткам — поэтому обязательно спавним их в открытом
    // месте, иначе им будет некуда шагнуть и они замрут на месте навсегда.
    // На старте уровня 0 открыта обычно только маленькая стартовая яма (и
    // полоска в самом верху) — сэмплируем по всей потенциальной высоте
    // уровня, а не по узкой зоне звёзд, иначе шанс попасть в яму почти нулевой.
    const enemyLocalYMin = level === 1 ? this.grassLineY + this.cellSize : this.cellSize + 1
    const enemyLocalYMax = height - 1

    // Область, в которой вражеским червякам и стражу вообще разрешено
    // находиться/двигаться (передаётся как areaTop/areaHeight в их
    // конструкторы). На уровне 1 это только полоса ПОД травой — не сама
    // видимая земля, где ходит игрок сверху, а именно подкопанный слой:
    // так они физически не могут вылезти выше линии травы, даже прогрызя
    // саму травяную клетку (проверка границ у них — не по стенам, а по
    // этому диапазону Y).
    const enemyAreaTop = level === 1 ? startY + this.grassLineY : startY
    const enemyAreaHeight = level === 1 ? height - this.grassLineY : height

    const findOpenSpot = (localYMin: number, localYMax: number): { x: number; y: number } => {
      const range = Math.max(localYMax - localYMin, 1)
      let x = startX + this.rng() * (width - 100) + 50
      let y = startY + localYMin + this.rng() * range

      for (let attempt = 0; attempt < FIND_OPEN_SPOT_MAX_ATTEMPTS; attempt++) {
        if (!isPointBlocked(levelWalls, x, y)) break
        x = startX + this.rng() * (width - 100) + 50
        y = startY + localYMin + this.rng() * range
      }

      return { x, y }
    }

    // Домик вражеских червяков — один на уровень, всегда в верхней части
    // ПОДКОПАННОГО слоя (на уровне 0 это гарантированно открытая полоска у
    // самого потолка, на уровне 1 — верх песка сразу под травой; не выше
    // травы, там теперь ходит муравей).
    const nestLocalYMin = level === 1 ? this.grassLineY + this.cellSize : this.cellSize + 1
    const nestLocalYMax = level === 1 ? this.grassLineY + this.cellSize * 6 : this.cellSize * 3
    const nestSpot = findOpenSpot(nestLocalYMin, nestLocalYMax)
    this.addEntity(new Nest(nestSpot.x, nestSpot.y))

    // Страж и воры должны появляться кучкой возле СВОЕЙ норы, а не где
    // попало по всему уровню — раньше их спавн вообще не зависел от норы,
    // так что они вполне могли оказаться прямо рядом со стартовой точкой
    // игрока. Берём случайную точку в радиусе ENEMY_NEST_SPAWN_RADIUS от
    // норы (зажатую в границы уровня и в свою Y-полосу) и, как и обычный
    // findOpenSpot, перебираем попытки, пока не найдём непрокопанную клетку.
    const findOpenSpotNearNest = (localYMin: number, localYMax: number): { x: number; y: number } => {
      const range = Math.max(localYMax - localYMin, 1)
      const minX = startX + 50
      const maxX = startX + width - 50
      const minY = startY + localYMin
      const maxY = startY + localYMin + range

      const sample = () => ({
        x: Math.min(maxX, Math.max(minX, nestSpot.x + (this.rng() * 2 - 1) * ENEMY_NEST_SPAWN_RADIUS)),
        y: Math.min(maxY, Math.max(minY, nestSpot.y + (this.rng() * 2 - 1) * ENEMY_NEST_SPAWN_RADIUS)),
      })

      let spot = sample()
      for (let attempt = 0; attempt < FIND_OPEN_SPOT_MAX_ATTEMPTS; attempt++) {
        if (!isPointBlocked(levelWalls, spot.x, spot.y)) break
        spot = sample()
      }

      return spot
    }

    // Страж — патрулирует рядом с норой в той же полосе, перекрывая проход
    // игроку (см. GameScene.update — реагирует только на игрока, вражеских
    // воров вообще не замечает).
    const guardSpot = findOpenSpotNearNest(nestLocalYMin, nestLocalYMax)
    const guard = new GuardWorm(guardSpot.x, guardSpot.y, enemyAreaTop, enemyAreaHeight, "guard:0")
    this.addEntity(guard)
    guard.init()

    for (let i = 0; i < ENEMIES_PER_LEVEL; i++) {
      const spot = findOpenSpotNearNest(enemyLocalYMin, enemyLocalYMax)
      const enemy = new EnemyWorm(spot.x, spot.y, enemyAreaTop, enemyAreaHeight, nestSpot.x, nestSpot.y, `enemy:${i}`)
      this.addEntity(enemy)
      enemy.init()
    }

    this.updateHud()
  }

  private addEntity(entity: Entity): void {
    this.entities.push(entity)
    this.worldContainer.addChild(entity.container)
  }

  /**
   * HUD со счётом собранных звёзд. Живёт в this.container (а не в
   * worldContainer), поэтому не двигается вместе с камерой и не зумируется
   * во время метаморфозы.
   */
  private setupHud(): void {
    if (this.starsText) {
      this.updateHud()
      // На перезапуске уровня worldContainer переставляется в конец списка
      // детей this.container и перекрывает HUD — возвращаем HUD наверх.
      this.container.addChild(this.hudContainer)
      return
    }

    this.starsText = new Text({
      text: "⭐ 0/0",
      style: new TextStyle({
        fontFamily: "sans-serif",
        fontSize: 20,
        fontWeight: "bold",
        fill: 0xffd700,
        stroke: { color: 0x1a110b, width: 4 },
      }),
    })

    this.starsText.position.set(16, 16)
    this.hudContainer.addChild(this.starsText)

    this.hintText = new Text({
      text: "Собери все звёзды, чтобы пройти дальше!",
      style: new TextStyle({
        fontFamily: "sans-serif",
        fontSize: 16,
        fontWeight: "bold",
        fill: 0xffffff,
        stroke: { color: 0x1a110b, width: 4 },
      }),
    })
    this.hintText.anchor.set(0.5, 0)
    this.hintText.position.set(window.innerWidth / 2, 16)
    this.hintText.visible = false
    this.hudContainer.addChild(this.hintText)

    this.revealText = new Text({
      text: "🔥 Карта видна: 60с",
      style: new TextStyle({
        fontFamily: "sans-serif",
        fontSize: 18,
        fontWeight: "bold",
        fill: 0xffb84d,
        stroke: { color: 0x1a110b, width: 4 },
      }),
    })
    this.revealText.anchor.set(1, 0)
    this.revealText.position.set(window.innerWidth - 16, 16)
    this.revealText.visible = false
    this.hudContainer.addChild(this.revealText)

    // Счётчик листьев — виден только на уровне 3+ (поверхность с лужами),
    // на копании он бессмысленен, поэтому по умолчанию скрыт (см.
    // updateHud — показывается, только когда levelIndex >= 2).
    this.leavesText = new Text({
      text: "🍃 0",
      style: new TextStyle({
        fontFamily: "sans-serif",
        fontSize: 18,
        fontWeight: "bold",
        fill: 0x8fe388,
        stroke: { color: 0x1a110b, width: 4 },
      }),
    })
    this.leavesText.position.set(16, 44)
    this.leavesText.visible = false
    this.hudContainer.addChild(this.leavesText)

    // Счётчик буста скорости — виден только пока действует (как revealText).
    this.speedText = new Text({
      text: "⚡ Ускорение: 0с",
      style: new TextStyle({
        fontFamily: "sans-serif",
        fontSize: 18,
        fontWeight: "bold",
        fill: 0xd4ff5e,
        stroke: { color: 0x1a110b, width: 4 },
      }),
    })
    this.speedText.anchor.set(1, 0)
    this.speedText.position.set(window.innerWidth - 16, 44)
    this.speedText.visible = false
    this.hudContainer.addChild(this.speedText)

    // Стрелка на напарника (co-op) — треугольник, "нос" смотрит вверх по
    // умолчанию (локально), реальное направление задаётся поворотом в
    // updatePartnerArrow(). Ребёнок hudContainer — так на рестарте уровня
    // (см. ветку выше) переживает вместе со всем остальным HUD.
    this.partnerArrow.beginFill(PARTNER_ARROW_COLOR)
    this.partnerArrow.lineStyle(2, 0x1a110b, 0.85)
    this.partnerArrow.moveTo(0, -14)
    this.partnerArrow.lineTo(9, 8)
    this.partnerArrow.lineTo(0, 2)
    this.partnerArrow.lineTo(-9, 8)
    this.partnerArrow.closePath()
    this.partnerArrow.endFill()
    this.partnerArrow.visible = false
    this.partnerArrow.alpha = 0
    this.hudContainer.addChild(this.partnerArrow)

    this.container.addChild(this.hudContainer)
  }

  /** Сколько звёзд показывать в HUD/сверять с totalStars для двери — в co-op
   * это ОБЩИЙ счёт команды (сервер, см. GameNetworkStore.getTeamStars), а не
   * локальный this.collectedStars (тот в co-op больше не используется). */
  private displayedCollectedStars(): number {
    return this.network.getSnapshot().mode === "coop" ? this.network.getTeamStars() : this.collectedStars
  }

  private updateHud(): void {
    if (this.starsText) {
      this.starsText.text = `⭐ ${this.displayedCollectedStars()}/${this.totalStars}`
    }

    if (this.leavesText) {
      // Листья нужны только на уровне 2 (лужи) — на воде (4+) их уже некуда
      // тратить (там нет луж), так что счётчик там снова прячем.
      this.leavesText.visible = this.levelIndex === 2
      this.leavesText.text = `🍃 ${this.carriedLeaves}`
    }
  }

  /**
   * Тёмный слой поверх мира с "дыркой" вокруг игрока (радиальный градиент от
   * прозрачного к почти чёрному). Рисуем его через нативный canvas
   * (createRadialGradient честно учитывает альфа-канал стопов, в отличие от
   * Pixi Graphics/FillGradient) и превращаем в текстуру спрайта. Спрайт живёт
   * в this.container, не в worldContainer, поэтому не масштабируется во время
   * зума метаморфозы — мы просто прячем его на это время. Текстуру делаем
   * сильно больше экрана, чтобы тьма гарантированно закрывала все края, где
   * бы ни оказался игрок.
   */
  private setupFog(): void {
    if (!this.fogSprite) {
      this.fogSize = Math.max(window.innerWidth, window.innerHeight) * FOG_SIZE_MULTIPLIER

      this.fogSprite = new Sprite(this.buildFogTexture())
      this.fogSprite.anchor.set(0.5)
      this.fogSprite.eventMode = "none"

      this.fogContainer.addChild(this.fogSprite)
    } else {
      // На рестарте уровня радиус света мог быть увеличен пузырьками —
      // сбрасываем текстуру тумана под актуальный (сброшенный) lightRadius.
      this.rebuildFogTexture()
    }

    this.container.addChild(this.fogContainer)
  }

  /** Рисует радиальный градиент тумана в текущем lightRadius через canvas. */
  private buildFogTexture(): Texture {
    const canvas = document.createElement("canvas")
    canvas.width = this.fogSize
    canvas.height = this.fogSize

    const ctx = canvas.getContext("2d")
    if (ctx) {
      const center = this.fogSize / 2
      const gradient = ctx.createRadialGradient(center, center, this.lightRadius, center, center, this.lightRadius + this.lightSoftEdge)
      gradient.addColorStop(0, "rgba(10, 6, 4, 0)")
      gradient.addColorStop(1, "rgba(8, 4, 3, 0.97)")

      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, this.fogSize, this.fogSize)
    }

    return Texture.from(canvas)
  }

  /** Перестраивает текстуру тумана под новый lightRadius (после пузырька света). */
  private rebuildFogTexture(): void {
    if (!this.fogSprite) return

    const oldTexture = this.fogSprite.texture
    this.fogSprite.texture = this.buildFogTexture()
    oldTexture.destroy(true)
  }

  /**
   * Двигает "дырку" тумана к текущей экранной позиции игрока и включает
   * туман только пока копает червяк — на поверхности (муравей) и во время
   * зума метаморфозы туман скрыт.
   */
  private updateFog(): void {
    if (!this.fogSprite || !this.activePlayer) {
      return
    }

    const isDigging = this.activePlayer instanceof Worm && this.metaState === MetaState.NONE && !this.activePlayer.isDead

    // Пока действует факел-выключатель, туман скрыт целиком, даже если
    // условия для копания выполнены.
    this.fogContainer.visible = isDigging && this.revealTimer <= 0

    if (isDigging) {
      const screenPos = this.worldContainer.toGlobal(this.activePlayer.container.position)
      this.fogSprite.position.set(screenPos.x, screenPos.y)
    }
  }

  /** Считает секунды действия факела-выключателя и обновляет подпись в HUD. */
  private updateReveal(deltaTime: number): void {
    if (this.revealTimer <= 0) {
      return
    }

    this.revealTimer = Math.max(0, this.revealTimer - deltaTime)

    if (this.revealText) {
      this.revealText.visible = this.revealTimer > 0
      this.revealText.text = `🔥 Карта видна: ${Math.ceil(this.revealTimer)}с`
    }
  }

  /** Считает секунды действия пузырька скорости, обновляет подпись в HUD и
   * применяет/снимает множитель скорости у активного игрока — Worm и Ant
   * оба понимают speedMultiplier (см. их update()). В co-op активируется
   * одинаково у ОБОИХ игроков комнаты, раз оба считают его от одного и того
   * же общего speedBoostEndsAt (см. applyLevelDiff/drainBoostUpdates). */
  private updateSpeedBoost(deltaTime: number): void {
    if (this.speedBoostTimer > 0) {
      this.speedBoostTimer = Math.max(0, this.speedBoostTimer - deltaTime)
    }

    if (this.speedText) {
      this.speedText.visible = this.speedBoostTimer > 0
      this.speedText.text = `⚡ Ускорение: ${Math.ceil(this.speedBoostTimer)}с`
    }

    if (this.activePlayer && "speedMultiplier" in this.activePlayer) {
      this.activePlayer.speedMultiplier = this.speedBoostTimer > 0 ? SPEED_BOOST_MULTIPLIER : 1
    }
  }

  /**
   * Логика кинематографичного зума и метаморфоза
   */
  private handleMetamorphosis(deltaTime: number): void {
    this.metaTimer += deltaTime

    const playerX = this.activePlayer.container.x
    const playerY = this.activePlayer.container.y

    switch (this.metaState) {
      case MetaState.ZOOM_IN:
        if (this.worldContainer.scale.x < this.metaZoomScale) {
          const zoomSpeed = deltaTime * META_ZOOM_SPEED
          this.worldContainer.scale.x += zoomSpeed
          this.worldContainer.scale.y += zoomSpeed

          this.worldContainer.pivot.set(playerX, playerY)
          this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
        } else {
          this.metaState = MetaState.TRANSFORM
          this.metaTimer = 0
        }
        break

      case MetaState.TRANSFORM:
        this.activePlayer.container.alpha = Math.sin(this.metaTimer * 30) * 0.4 + 0.6
        this.activePlayer.container.scale.set(Math.sin(this.metaTimer * 12) * 0.15 + 1)

        if (this.metaTimer >= TRANSFORM_DURATION) {
          this.worldContainer.removeChild(this.activePlayer.container)
          this.entities = this.entities.filter((e) => e !== this.activePlayer)

          if (this.activePlayer instanceof Worm) {
            // Y муравья фиксируем на линии травы (та же формула, что и в
            // onCreate/SaveButton), а не берём "как есть" от червяка: тот
            // ловится триггером ZOOM_IN уже НЕДОкопав ровно до травы (см.
            // localPlayerY <= grassLineY + 40 — до 40px ниже самой травы), и
            // раз Ant.update() никогда не двигает container.y, муравей навсегда
            // оставался бы вкопанным в песок чуть ниже поверхности — не видно
            // "хождения по траве", да и AABB кнопки сохранения (на grassLineY-6)
            // с ним попросту не пересекался.
            const antY = this.currentLevelYOffset + this.grassLineY - 6
            const ant = new Ant(this.input, playerX, antY)
            this.activePlayer = ant

            this.addEntity(ant)
            this.worldContainer.addChild(ant.container)

            console.log("Метаморфоз завершен! Родился Муравей.")
          } else {
            // Ant -> Frog: муравей у правого края уровня 2 (лужи/листья)
            // превращается в жабу — и заодно уровень тут же переходит на
            // следующий (водный) сегмент, тем же приёмом, что и обычный
            // переход между сегментами муравья (levelIndex++, X-смещение на
            // ширину экрана, чистка сущностей позади), только сопровождается
            // самим превращением, а не происходит мгновенно.
            this.levelIndex++
            this.currentLevelXOffset += window.innerWidth

            const safeXBound = this.currentLevelXOffset - window.innerWidth * 2
            this.entities = this.entities.filter((entity) => {
              if (entity.container.x < safeXBound) {
                this.worldContainer.removeChild(entity.container)
                return false
              }
              return true
            })

            this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)

            // Жаба рождается по центру высоты водного сегмента — свободного
            // плавания по вертикали у муравья не было, так что фиксированной
            // "линии травы" тут взять неоткуда.
            const frogY = this.currentLevelYOffset + window.innerHeight / 2
            const frogX = this.currentLevelXOffset + 60
            const frog = new Frog(this.input, frogX, frogY)
            this.activePlayer = frog

            this.addEntity(frog)
            this.worldContainer.addChild(frog.container)

            console.log("Метаморфоз завершён! Рождена Жаба.")
          }

          this.metaState = MetaState.ZOOM_OUT
        }
        break

      case MetaState.ZOOM_OUT: {
        // Название состояния осталось от старой версии (когда камера
        // действительно зумилась обратно до 1x) — теперь же она, наоборот,
        // доводится ДО целевого зума новой формы (antFocusZoomScale у
        // муравья, frogFocusZoomScale у жабы — оба больше пикового зума
        // самого превращения) и остаётся там: игрок всегда в фокусе камеры,
        // она не возвращается к обычному виду всего экрана.
        const targetZoomScale = this.activePlayer instanceof Frog ? this.frogFocusZoomScale : this.antFocusZoomScale

        if (this.worldContainer.scale.x < targetZoomScale) {
          const zoomSpeed = deltaTime * META_ZOOM_SPEED
          this.worldContainer.scale.x += zoomSpeed
          this.worldContainer.scale.y += zoomSpeed

          this.worldContainer.pivot.set(playerX, playerY)
          this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
        } else {
          this.worldContainer.scale.set(targetZoomScale)
          this.worldContainer.pivot.set(playerX, playerY)
          this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)

          // ИСПРАВЛЕНО: Сбрасываем стейт в NONE вместо COMPLETE, чтобы разблокировать апдейты игры и вернуть управление
          this.metaState = MetaState.NONE
        }
        break
      }

      case MetaState.COMPLETE:
        break
    }
  }

  /** Тот же критерий "мобильный/тач-экран", что и у сенсорного джойстика
   * (см. TouchControls.module.scss: pointer:coarse ИЛИ узкий viewport). */
  private isMobileViewport(): boolean {
    if (typeof window === "undefined") return false
    return window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 820
  }

  /** Итоговая высота уровней 0/1 — как и раньше, плюс дополнительный
   * множитель на мобильных (см. MOBILE_DIG_LEVEL_EXTRA_MULTIPLIER). Все
   * места, что раньше считали "window.innerHeight * DIG_LEVEL_HEIGHT_MULTIPLIER"
   * напрямую, обязаны использовать этот метод — иначе оффсеты между
   * уровнями разъедутся с тем, что реально сгенерировано. */
  private digLevelHeight(): number {
    const extra = this.isMobileViewport() ? MOBILE_DIG_LEVEL_EXTRA_MULTIPLIER : 1
    return window.innerHeight * DIG_LEVEL_HEIGHT_MULTIPLIER * extra
  }

  /** Итоговая ширина уровней 0/1 — на десктопе равна экрану (как и раньше),
   * на мобильных — шире. Горизонтальных уровней 2+ (бег муравья) не касается —
   * их ширина завязана на переход между сегментами, трогать её нельзя (см.
   * MOBILE_DIG_LEVEL_EXTRA_MULTIPLIER). */
  private digLevelWidth(): number {
    return window.innerWidth * (this.isMobileViewport() ? MOBILE_DIG_LEVEL_EXTRA_MULTIPLIER : 1)
  }

  private restartLevel(): void {
    this.worldContainer.removeChildren()
    this.entities = []
    // Контейнеры напарника уже уничтожены строкой выше (removeChildren) —
    // забываем и сами инстансы, иначе следующий syncNetwork() попытается
    // двигать сущности, которых больше нет в мире, вместо того чтобы
    // создать их заново.
    this.remoteEntities.clear()
    this.deathTimer = 0
    this.onCreate()
  }

  /**
   * Co-op: отправляет позицию нашего игрока остальным и заводит/двигает/
   * убирает сущности напарников — каждый напарник ровно тот же Worm/Ant,
   * что и локальный игрок, просто ведомый сетевым снапшотом, а не вводом
   * (см. GameSocket/GameNetworkStore и комментарий у remoteEntities выше).
   * В single player — ранний return, ничего не делает.
   */
  private syncNetwork(deltaTime: number): void {
    if (this.network.getSnapshot().mode !== "coop") return

    if (this.activePlayer) {
      const form: PlayerForm = this.activePlayer instanceof Ant ? "ant" : "worm"
      this.network.reportLocalPose(this.activePlayer.container.x, this.activePlayer.container.y, form)
    }

    const remoteStates = this.network.getRemotePlayerStates()
    const seenPlayerIds = new Set<string>()

    for (const state of remoteStates) {
      seenPlayerIds.add(state.playerId)
      this.upsertRemoteEntity(state)
    }

    for (const [playerId, remote] of this.remoteEntities) {
      if (seenPlayerIds.has(playerId)) continue

      this.worldContainer.removeChild(remote.entity.container)
      this.entities = this.entities.filter((e) => e !== remote.entity)
      this.remoteEntities.delete(playerId)
    }

    this.updatePartnerArrow(deltaTime)
  }

  /** true, если это сущность напарника (см. remoteEntities) — такие исключаются
   * из обычного per-entity update() цикла (см. вызов ниже в update()). */
  private isRemoteEntity(entity: Entity): boolean {
    for (const remote of this.remoteEntities.values()) {
      if (remote.entity === entity) return true
    }
    return false
  }

  /** "host" — игрок, зашедший в комнату первым (RoomInfo.players[0]), "guest" —
   * второй. Порядок в RoomInfo.players общий для обоих клиентов (см.
   * PlayerCosmetics) — оба клиента всегда сходятся, кто есть кто. */
  private getRemoteRole(playerId: string): PartnerRole {
    const players = this.network.getSnapshot().roomInfo?.players ?? []
    const index = players.findIndex((p) => p.playerId === playerId)
    return index === 0 ? "host" : "guest"
  }

  /** Создаёт (при первом появлении), пересоздаёт (при смене формы — прошёл
   * метаморфозу у себя) и двигает сущность одного напарника. */
  private upsertRemoteEntity(state: PlayerState): void {
    let remote = this.remoteEntities.get(state.playerId)

    if (!remote) {
      const worm = new Worm(this.dummyInput)
      worm.container.x = state.x
      worm.container.y = state.y
      worm.init()
      worm.applyRemoteLook(this.getRemoteRole(state.playerId))

      remote = { entity: worm, form: "worm" }
      this.remoteEntities.set(state.playerId, remote)
      this.addEntity(worm)
    }

    if (remote.form !== state.form) {
      // Напарник прошёл метаморфозу у себя — пересоздаём тем же классом,
      // что и локальный игрок (Worm -> Ant), без кат-сцены с зумом: камера
      // в этой сцене одна и следит только за нашим собственным игроком.
      this.worldContainer.removeChild(remote.entity.container)
      this.entities = this.entities.filter((e) => e !== remote!.entity)

      const nextEntity: Worm | Ant = new Ant(this.dummyInput, state.x, state.y)
      nextEntity.applyRemoteLook(this.getRemoteRole(state.playerId))
      remote = { entity: nextEntity, form: state.form }
      this.remoteEntities.set(state.playerId, remote)
      this.addEntity(nextEntity)
    }

    if (remote.entity instanceof Ant) {
      remote.entity.setRemotePosition(state.x)
    } else {
      remote.entity.setRemotePosition(state.x, state.y)
    }
  }

  /**
   * Стрелка на краю экрана, указывающая направление на напарника, если его
   * не видно в кадре — прячется сама, как только он снова попадает в
   * видимую область. Плавно доводит позицию/поворот/прозрачность до цели
   * каждый кадр (см. PARTNER_ARROW_SMOOTHING), а не прыгает мгновенно. В
   * single player remoteEntities всегда пуст — стрелка остаётся скрытой.
   */
  private updatePartnerArrow(deltaTime: number): void {
    const remote = this.remoteEntities.values().next().value

    let targetAlpha = 0
    let targetX = this.partnerArrowX
    let targetY = this.partnerArrowY
    let targetAngle = this.partnerArrowAngle

    if (remote) {
      const screenPos = this.worldContainer.toGlobal(remote.entity.container.position)

      const left = PARTNER_ARROW_MARGIN
      const right = window.innerWidth - PARTNER_ARROW_MARGIN
      const top = PARTNER_ARROW_TOP_MARGIN
      const bottom = window.innerHeight - PARTNER_ARROW_MARGIN
      const isOnScreen = screenPos.x >= left && screenPos.x <= right && screenPos.y >= top && screenPos.y <= bottom

      if (!isOnScreen) {
        targetAlpha = 1

        // "Безопасный" прямоугольник — от него стрелка никогда не уезжает
        // дальше кромки и не перекрывает счётчики звёзд/листьев сверху
        // (см. PARTNER_ARROW_TOP_MARGIN) — центр по Y у него свой, не
        // экранный, отступы сверху и снизу разные не просто так.
        const rectCx = window.innerWidth / 2
        const rectCy = (top + bottom) / 2
        const halfW = (right - left) / 2
        const halfH = (bottom - top) / 2

        const angle = Math.atan2(screenPos.y - rectCy, screenPos.x - rectCx)
        const dirX = Math.cos(angle)
        const dirY = Math.sin(angle)
        const scaleToEdge = Math.min(dirX !== 0 ? halfW / Math.abs(dirX) : Infinity, dirY !== 0 ? halfH / Math.abs(dirY) : Infinity)

        targetX = rectCx + dirX * scaleToEdge
        targetY = rectCy + dirY * scaleToEdge
        // Локально "нос" треугольника смотрит вверх (угол -PI/2) — довернуть
        // его до направления angle нужно ровно на angle + PI/2.
        targetAngle = angle + Math.PI / 2
      }
    }

    const smoothing = Math.min(1, PARTNER_ARROW_SMOOTHING * deltaTime)
    this.partnerArrowAlpha += (targetAlpha - this.partnerArrowAlpha) * smoothing
    this.partnerArrowX += (targetX - this.partnerArrowX) * smoothing
    this.partnerArrowY += (targetY - this.partnerArrowY) * smoothing

    // Кратчайший путь по кругу — иначе стрелка иногда крутилась бы "в
    // длинную сторону", проезжая почти полный оборот вместо короткого доворота.
    let angleDiff = targetAngle - this.partnerArrowAngle
    angleDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff))
    this.partnerArrowAngle += angleDiff * smoothing

    this.partnerArrow.position.set(this.partnerArrowX, this.partnerArrowY)
    this.partnerArrow.rotation = this.partnerArrowAngle
    this.partnerArrow.alpha = this.partnerArrowAlpha
    this.partnerArrow.visible = this.partnerArrowAlpha > 0.02
  }

  public update(deltaTime: number): void {
    this.syncNetwork(deltaTime)
    this.updateReveal(deltaTime)
    this.updateSpeedBoost(deltaTime)
    this.updateFog()

    // Общий мир копания (уровни 0/1) — широковещательные "весь мир меняется
    // разом" события (рестарт всей комнаты / переход 0->1) обрабатываем ДО
    // остальной логики кадра и сразу выходим — applyRoomRestart/applyLevelAdvanced
    // сами перестраивают всю сцену (restartLevel()/полная регенерация уровня).
    if (this.network.getSnapshot().mode === "coop") {
      const restarted = this.network.drainRoomRestart()
      if (restarted) {
        this.applyRoomRestart(restarted)
        return
      }

      const advanced = this.network.drainLevelAdvanced()
      if (advanced) {
        this.applyLevelAdvanced(advanced)
        return
      }

      if (this.levelIndex <= 1) {
        this.processSharedLevelEvents()
      }
    }

    if (this.metaState !== MetaState.NONE) {
      this.handleMetamorphosis(deltaTime)
      return
    }

    if (this.activePlayer && this.activePlayer.isDead) {
      this.deathTimer += deltaTime
      if (this.deathTimer >= DEATH_RESTART_DELAY) {
        if (this.network.getSnapshot().mode === "coop" && this.levelIndex <= 1) {
          // Погибли на общем уровне — просим сервер перезапустить ВСЮ
          // комнату (иначе карты игроков тут же разошлись бы). Реальный
          // рестарт произойдёт из applyRoomRestart() выше, по широковещательному
          // событию, а не тут напрямую — не дублируем заявку каждый кадр.
          if (!this.pendingRoomRestart) {
            this.pendingRoomRestart = true
            this.network.requestRoomRestart(this.roomLevelWidth, this.roomLevelHeight)
          }
        } else {
          this.restartLevel()
        }
      }
      return
    }

    if (this.activePlayer) {
      const localPlayerY = this.activePlayer.container.y - this.currentLevelYOffset

      if (this.hintText) this.hintText.visible = false

      // ИСПРАВЛЕНО: Добавлено условие `this.activePlayer instanceof Worm`.
      // Благодаря этому запуск метаморфоза сработает только для червяка. Муравей повторно вызывать зум не будет.
      if (this.levelIndex === 1 && localPlayerY <= this.grassLineY + 40 && this.activePlayer instanceof Worm) {
        this.metaState = MetaState.ZOOM_IN
        this.metaTimer = 0
        return
      }

      // Это исключительно про подъём червяка к потолку уровня копания (0/1) —
      // муравей/жаба никогда не оказываются настолько близко к
      // currentLevelYOffset (см. их собственные, гораздо большие Y), но без
      // явной проверки типа жаба, доплыв случайно почти до самого верха
      // водного сегмента, приняла бы это за "верх уровня копания" и откатила
      // бы саму себя назад/запустила бы генерацию несуществующего уровня.
      if (this.activePlayer instanceof Worm && this.activePlayer.container.y <= this.currentLevelYOffset + 40) {
        const isCoop = this.network.getSnapshot().mode === "coop"

        if (this.displayedCollectedStars() < this.totalStars) {
          // Не все звёзды текущего уровня (в co-op — команды целиком)
          // собраны — невидимая стена не пускает наверх, пока не соберут.
          this.activePlayer.container.y = this.currentLevelYOffset + 40
          if (this.hintText) this.hintText.visible = true
        } else if (isCoop) {
          // Общий уровень — переход выполняется не тут, а широковещательно
          // (см. applyLevelAdvanced), чтобы оба игрока комнаты перешли
          // одновременно на одну и ту же новую карту. Пока не пришёл ответ,
          // просто держим игрока у двери (как и в ветке "не все собраны"
          // выше) и не дублируем заявку каждый кадр.
          this.activePlayer.container.y = this.currentLevelYOffset + 40
          if (!this.pendingAdvanceLevel) {
            this.pendingAdvanceLevel = true
            this.network.requestAdvanceLevel(0, 1, this.roomLevelWidth, this.roomLevelHeight)
          }
        } else {
          // Камера и так уже плавно следует за червяком (см. followLerp
          // ниже) — отдельного "панорамного" перехода не нужно, она
          // естественно нагонит его на новом (увеличенном) уровне сама же.
          this.levelIndex++

          this.currentLevelYOffset -= this.digLevelHeight()

          const safeYBound = this.currentLevelYOffset + this.digLevelHeight() * 2
          this.entities = this.entities.filter((entity) => {
            if (entity !== this.activePlayer && entity.container.y > safeYBound) {
              // Несобранные звёзды, оставшиеся позади за пределами уровня,
              // больше не собрать — убираем их и из знаменателя счётчика.
              if (entity instanceof Star && entity.container.visible) {
                this.totalStars--
              }
              this.worldContainer.removeChild(entity.container)
              return false
            }
            return true
          })

          this.updateHud()

          this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)

          this.worldContainer.addChild(this.activePlayer.container)
          return
        }
      }

      // Уровень 3 (индекс 2): начинается, когда муравей добегает до правого
      // края экрана на уровне 1 — камера едет вправо, открывая новый кусок
      // поверхности, симметрично тому, как вертикальные уровни открываются
      // вверх при достижении верхнего края.
      if (this.activePlayer instanceof Ant && this.levelIndex === 1) {
        const localPlayerX = this.activePlayer.container.x - this.currentLevelXOffset

        if (localPlayerX >= window.innerWidth - 40) {
          // Камера постоянно сфокусирована на муравье (см. ZOOM_OUT в
          // handleMetamorphosis) — плавный "панорамный" переход тут не
          // нужен: она и так уже смотрит точно на него и продолжит
          // смотреть на него же после генерации нового куска земли.
          this.levelIndex++

          this.currentLevelXOffset += window.innerWidth

          const safeXBound = this.currentLevelXOffset - window.innerWidth * 2
          this.entities = this.entities.filter((entity) => {
            if (entity !== this.activePlayer && entity.container.x < safeXBound) {
              this.worldContainer.removeChild(entity.container)
              return false
            }
            return true
          })

          this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)

          this.worldContainer.addChild(this.activePlayer.container)
          return
        }
      }

      // Уровень 4 (индекс 3): муравей добегает до правого края уровня 3
      // (лужи/листья) — тут, в отличие от перехода уровень1->уровень2 выше,
      // происходит не просто смена сегмента, а метаморфоза в жабу (симметрично
      // тому, как червяк на уровне 1 превращается в муравья на грани травы).
      // Сама смена сегмента (levelIndex++/X-смещение/generateNextLevel)
      // происходит уже ПОСЛЕ анимации, в handleMetamorphosis (TRANSFORM).
      if (this.activePlayer instanceof Ant && this.levelIndex === 2) {
        const localPlayerX = this.activePlayer.container.x - this.currentLevelXOffset

        if (localPlayerX >= window.innerWidth - 40) {
          this.metaState = MetaState.ZOOM_IN
          this.metaTimer = 0
          return
        }
      }

      // Следующий водный сегмент (уровень 5+): жаба доплывает до правого
      // края текущего сегмента — тот же приём смены сегмента, что и у
      // муравья на уровне 1->2 (без метаморфозы, форма уже не меняется).
      if (this.activePlayer instanceof Frog && this.levelIndex >= 3) {
        const localPlayerX = this.activePlayer.container.x - this.currentLevelXOffset

        if (localPlayerX >= window.innerWidth - 40) {
          this.levelIndex++
          this.currentLevelXOffset += window.innerWidth

          const safeXBound = this.currentLevelXOffset - window.innerWidth * 2
          this.entities = this.entities.filter((entity) => {
            if (entity !== this.activePlayer && entity.container.x < safeXBound) {
              this.worldContainer.removeChild(entity.container)
              return false
            }
            return true
          })

          this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)

          this.worldContainer.addChild(this.activePlayer.container)
          return
        }
      }

      // Плавное слежение камеры за червяком во время копания, с постоянным
      // приближением (wormFocusZoomScale) — тот же принцип, что и у
      // муравья: pivot держит игрока по центру экрана, только доводится до
      // него с отставанием (cameraFollowLerp), а не прыгает мгновенно.
      if (this.activePlayer instanceof Worm) {
        const followAmount = Math.min(1, this.cameraFollowLerp * deltaTime)
        this.worldContainer.pivot.x += (this.activePlayer.container.x - this.worldContainer.pivot.x) * followAmount
        this.worldContainer.pivot.y += (this.activePlayer.container.y - this.worldContainer.pivot.y) * followAmount
        this.worldContainer.scale.set(this.wormFocusZoomScale)
        this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
      }
    }

    const walls = this.entities.filter((e): e is Wall => e instanceof Wall)
    const stars = this.entities.filter((e): e is Star => e instanceof Star)

    let prevPlayerX = 0
    let prevPlayerY = 0

    const isCoopShared = this.network.getSnapshot().mode === "coop" && this.levelIndex <= 1

    if (this.activePlayer && this.entities.includes(this.activePlayer)) {
      // По id, а не просто по счётчику — в co-op нужно знать, КАКИЕ именно
      // звёзды пропали, чтобы запросить их зачёт у сервера (см. ниже).
      const starsVisibleBefore = new Map(stars.map((star) => [star.id, star.container.visible]))

      prevPlayerX = this.activePlayer.container.x
      prevPlayerY = this.activePlayer.container.y

      this.activePlayer.update(deltaTime, walls, stars)

      if (this.activePlayer instanceof Ant) {
        // Борта текущего экрана — считаем относительно currentLevelXOffset,
        // а не абсолютных window.innerWidth: после перехода на уровень 2
        // (камера едет вправо) абсолютные координаты муравья перестают
        // совпадать с координатами экрана. Правый край не зажат жёстко —
        // на уровне 1 переход на следующий уровень срабатывает раньше, чем
        // муравей сюда дойдёт (см. проверку localPlayerX выше), а на
        // уровне 2+ это просто не даёт уйти в ещё не сгенерированную пустоту.
        const minX = this.currentLevelXOffset + 20
        const maxX = this.currentLevelXOffset + window.innerWidth - 20
        this.activePlayer.container.x = Math.min(Math.max(this.activePlayer.container.x, minX), maxX)

        // Кусочки листа (уровень 3+) — подбираются на ходу, как звёзды/
        // пузырьки, и копятся в carriedLeaves до тех пор, пока не встретится
        // лужа, которую нужно перекрыть мостиком (см. ниже).
        const leaves = this.entities.filter((e): e is Leaf => e instanceof Leaf)
        for (const leaf of leaves) {
          if (leaf.container.visible && this.activePlayer.isColliding(leaf)) {
            leaf.container.visible = false
            this.carriedLeaves++
            this.updateHud()
          }
        }

        // Лужи (уровень 3+) — не пускают дальше, пока не наведён мостик. Есть
        // с собой лист — тратим один и наводим мостик прямо на подходе,
        // дальше эта лужа проходима навсегда; нет листа — не пускаем дальше
        // той стороны, с которой муравей подошёл (не даём протиснуться).
        const puddles = this.entities.filter((e): e is Puddle => e instanceof Puddle)
        for (const puddle of puddles) {
          if (puddle.isBridged || !this.activePlayer.isColliding(puddle)) continue

          if (this.carriedLeaves > 0) {
            this.carriedLeaves--
            puddle.placeBridge()
            this.updateHud()
            continue
          }

          const antCenterX = this.activePlayer.container.x + this.activePlayer.width / 2
          const puddleCenterX = puddle.container.x + puddle.width / 2
          this.activePlayer.container.x =
            antCenterX < puddleCenterX
              ? puddle.container.x - this.activePlayer.width
              : puddle.container.x + puddle.width
        }

        // Камера держит фокус на муравье постоянно (зум доведён до
        // antFocusZoomScale в конце ZOOM_OUT и больше не сбрасывается) —
        // каждый кадр подводим pivot к его текущей позиции, иначе при ходьбе
        // он тут же вышел бы за пределы сильно приближенного вида.
        this.worldContainer.pivot.set(this.activePlayer.container.x, this.activePlayer.container.y)
        this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)

        // Кнопка сохранения — единственный способ сохранить прогресс.
        // Дошёл до неё муравьём — записываем текущий уровень в
        // localStorage (один раз, дальше кнопка просто гаснет зелёным).
        const saveButtons = this.entities.filter((e): e is SaveButton => e instanceof SaveButton)
        for (const button of saveButtons) {
          if (!button.isPressed && this.activePlayer.isColliding(button)) {
            button.press()
            this.saveLevelProgress(this.levelIndex)
            console.log(`Прогресс сохранён! Уровень ${this.levelIndex}.`)
          }
        }
      }

      if (this.activePlayer instanceof Frog) {
        // Жаба плавает свободно в толще воды — в отличие от муравья, границы
        // сегмента считаем по ОБЕИМ осям (X и Y), не только по X.
        const minX = this.currentLevelXOffset + FROG_EDGE_MARGIN
        const maxX = this.currentLevelXOffset + window.innerWidth - FROG_EDGE_MARGIN
        const minY = this.currentLevelYOffset + FROG_EDGE_MARGIN
        const maxY = this.currentLevelYOffset + window.innerHeight - FROG_EDGE_MARGIN
        this.activePlayer.container.x = Math.min(Math.max(this.activePlayer.container.x, minX), maxX)
        this.activePlayer.container.y = Math.min(Math.max(this.activePlayer.container.y, minY), maxY)

        // Камера держит фокус на жабе постоянно, как и на муравье — только
        // теперь ещё и по вертикали, раз жаба плавает по обеим осям.
        this.worldContainer.pivot.set(this.activePlayer.container.x, this.activePlayer.container.y)
        this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
      }

      const newlyHiddenStars = stars.filter((star) => starsVisibleBefore.get(star.id) && !star.container.visible)

      if (newlyHiddenStars.length > 0) {
        if (isCoopShared) {
          // Не считаем локально — общий счёт придёт широковещательно от
          // сервера (см. processSharedLevelEvents/starCollected), тем самым
          // и не даём двум игрокам одновременно подобрать одну звезду
          // (сервер проверяет уникальность starId, см. LevelStateService).
          for (const star of newlyHiddenStars) {
            this.network.requestStarPickup(this.levelIndex, star.id)
          }
        } else {
          this.collectedStars += newlyHiddenStars.length
          this.updateHud()
        }
      }

      // Пузырьки света не встроены в логику Worm.update — подбираем их прямо
      // тут через обычное AABB-пересечение и сразу расширяем радиус тумана.
      const bubbles = this.entities.filter((e): e is Bubble => e instanceof Bubble)
      for (const bubble of bubbles) {
        if (bubble.container.visible && this.activePlayer.isColliding(bubble)) {
          if (isCoopShared) {
            // Не гасим локально и не трогаем lightRadius тут же — ждём
            // подтверждения от сервера (boostUpdate), иначе при одновременном
            // касании двумя игроками бонус применился бы дважды.
            this.network.requestBoostActivate(this.levelIndex, bubble.id, "light")
          } else {
            bubble.container.visible = false
            this.lightRadius += this.lightRadiusPerBubble
            this.rebuildFogTexture()
            console.log("Пузырёк света собран! Радиус видимости увеличен.")
          }
        }
      }

      // Пузырьки скорости — тот же принцип, только временный буст вместо
      // постоянной добавки к радиусу (см. GameConfig.SPEED_BOOST_DURATION).
      const speedBubbles = this.entities.filter((e): e is SpeedBubble => e instanceof SpeedBubble)
      for (const speedBubble of speedBubbles) {
        if (speedBubble.container.visible && this.activePlayer.isColliding(speedBubble)) {
          if (isCoopShared) {
            this.network.requestBoostActivate(this.levelIndex, speedBubble.id, "speed")
          } else {
            speedBubble.container.visible = false
            this.speedBoostTimer = SPEED_BOOST_DURATION
            console.log("Пузырёк скорости собран! Скорость временно удвоена.")
          }
        }
      }

      // Факел-выключатель — так же, отдельным AABB-пересечением: подобрал —
      // на минуту туман войны полностью выключается.
      const revealSwitches = this.entities.filter((e): e is RevealSwitch => e instanceof RevealSwitch)
      for (const revealSwitch of revealSwitches) {
        if (revealSwitch.container.visible && this.activePlayer.isColliding(revealSwitch)) {
          if (isCoopShared) {
            this.network.requestLightActivate(this.levelIndex, revealSwitch.id)
          } else {
            revealSwitch.container.visible = false
            this.revealTimer = this.revealDuration
            if (this.revealText) {
              this.revealText.visible = true
              this.revealText.text = `🔥 Карта видна: ${this.revealDuration}с`
            }
            console.log("Факел зажжён! Карта видна на минуту.")
          }
        }
      }

      // Co-op: локальный игрок мог прогрызть блок (тот же приём — Wall
      // выставляет justHit в hit(), не только тут, но и (у хоста) в
      // EnemyWorm.digAt() ниже в этом же кадре, поэтому сканируем ПОСЛЕ обоих).
    }

    // Звёзды, уже сложенные кучкой у домика, не должны считаться "ничьими"
    // для воровства — иначе враг, только что донёсший звезду, тут же
    // хватает её снова и топчется на месте вместо того, чтобы искать
    // следующую. Игроку они всё равно видны и доступны — он получает
    // полный список stars, только враги — урезанный.
    const nestForFilter = this.entities.find((e): e is Nest => e instanceof Nest)
    const stealableStars = nestForFilter
      ? stars.filter((star) => Math.hypot(star.container.x - nestForFilter.container.x, star.container.y - nestForFilter.container.y) > NEST_STORAGE_RADIUS)
      : stars

    this.entities.forEach((entity) => {
      if (entity !== this.activePlayer && !(entity instanceof GuardWorm) && !this.isRemoteEntity(entity)) {
        // Передаём стены и звёзды всем сущностям — они не обязаны их
        // использовать (Wall/Star/Bubble/Nest их игнорируют), но вражеским
        // червякам это нужно: стены — чтобы не лезть сквозь непрокопанную
        // землю, звёзды — чтобы было что воровать (кроме уже сложенных у
        // домика — см. stealableStars выше). Стражей (GuardWorm) сюда не
        // пускаем — у них отдельный tick() ниже, реагирующий только на игрока.
        // Напарника (remote Worm/Ant) — тоже: у него своя физика уже
        // посчитана на ЕГО клиенте, обычный update() тут только сломает его
        // (например, найдёт "стену" прямо под ним в точке (0,0) до первого
        // сетевого снапшота и убьёт — двигаем его исключительно через
        // setRemotePosition в syncNetwork).
        entity.update(deltaTime, walls, stealableStars)
      }
    })

    // Страж реагирует только на игрока — вражеских воров ему вообще не
    // передаём, поэтому пока он занят погоней в одном тоннеле, вор спокойно
    // проскакивает мимо по другому пути. Столкновение с игроком смертельно:
    // откатываем игрока на позицию до этого кадра (как будто упёрся в
    // стену) и сразу убиваем — как от камня, дальше сработает обычный
    // рестарт уровня по deathTimer.
    const guards = this.entities.filter((e): e is GuardWorm => e instanceof GuardWorm)
    const playerForGuard = this.activePlayer && this.entities.includes(this.activePlayer) ? this.activePlayer : undefined

    for (const guard of guards) {
      guard.tick(deltaTime, walls, playerForGuard?.container.x, playerForGuard?.container.y)
    }

    if (playerForGuard) {
      for (const guard of guards) {
        if (playerForGuard.isColliding(guard)) {
          playerForGuard.container.x = prevPlayerX
          playerForGuard.container.y = prevPlayerY
          playerForGuard.kill()
          break
        }
      }
    }

    // Вражеские червяки воруют ничьи звёзды и тащат их в свой домик — там
    // звезда не пропадает навсегда, а складывается кучкой прямо у шалаша:
    // её видно (счётчик над домиком) и можно забрать обратно, как обычную
    // звезду. Столкновение с игроком по дороге заставляет вора выронить
    // украденное прямо на месте.
    const enemies = this.entities.filter((e): e is EnemyWorm => e instanceof EnemyWorm)
    const nest = nestForFilter

    // Co-op: только хост комнаты реально симулирует кражу/доставку звёзд —
    // канонические враги ОДНИ на комнату (см. EnemyWorm.setRemoteState).
    // Гость получает тот же результат визуально через applyEnemyNetStates()
    // (см. processSharedLevelEvents), а не пересчитывает эту логику сам.
    const isHostSimulating = !isCoopShared || this.network.isHost()

    if (isHostSimulating) {
      for (const enemy of enemies) {
        if (!enemy.carriedStar && enemy.stealCooldown <= 0) {
          const stolen = stealableStars.find((star) => star.container.visible && enemy.isColliding(star))
          if (stolen) {
            stolen.container.visible = false
            enemy.carriedStar = stolen
          }
        } else if (nest && enemy.carriedStar && enemy.isColliding(nest)) {
          // Разбрасываем звёзды кучкой вокруг домика, чтобы несколько штук не
          // легли ровно друг на друга.
          const angle = Math.random() * Math.PI * 2
          const scatter = NEST_SCATTER_MIN + Math.random() * NEST_SCATTER_RANGE
          enemy.carriedStar.container.position.set(nest.container.x + Math.cos(angle) * scatter, nest.container.y + Math.sin(angle) * scatter)
          enemy.carriedStar.container.visible = true
          enemy.carriedStar = undefined
          console.log("Вражеский червяк донёс звезду до домика!")
        }

        if (enemy.carriedStar && this.activePlayer && this.entities.includes(this.activePlayer) && this.activePlayer.isColliding(enemy)) {
          enemy.carriedStar.container.position.set(enemy.container.x, enemy.container.y)
          enemy.carriedStar.container.visible = true
          enemy.carriedStar = undefined
          // Не даём тут же схватить её обратно, пока игрок не отойдёт — иначе
          // получается бесконечный цикл "украл-уронил" на одном месте.
          enemy.stealCooldown = STEAL_COOLDOWN_AFTER_DROP
          console.log("Вражеский червяк уронил украденную звезду!")
        }
      }
    }

    if (nest) {
      const storedCount = stars.reduce(
        (count, star) =>
          count + (star.container.visible && Math.hypot(star.container.x - nest.container.x, star.container.y - nest.container.y) <= NEST_STORAGE_RADIUS ? 1 : 0),
        0,
      )
      nest.setStoredCount(storedCount)
    }

    if (isCoopShared) {
      // Общий дифф копания — сканируем ПОСЛЕ всех апдейтов этого кадра
      // (игрок уже прогрыз своё выше, хост-враги — в entities.forEach чуть
      // раньше в этом же кадре), чтобы не упустить ни один удар.
      for (const wall of walls) {
        if (!wall.justHit || !wall.cellKey) continue
        wall.justHit = false
        const hits = wall.maxHitPoints - wall.hitPoints
        this.network.reportWallHit(this.levelIndex, wall.cellKey, hits, wall.hitPoints <= 0)
      }

      // Только хост реально шлёт это (см. GameNetworkStore.sendEnemyState) —
      // сервер лишь хранит последнее известное состояние и ретранслирует
      // партнёру, сама AI-симуляция остаётся полностью локальной у хоста.
      if (this.network.isHost()) {
        const netStates: EnemyNetState[] = [
          ...guards.map((g) => g.toNetState()),
          ...enemies.map((e) => e.toNetState(e.carriedStar?.id ?? null)),
        ]
        this.network.sendEnemyState(this.levelIndex, netStates)
      }
    }
  }
}
