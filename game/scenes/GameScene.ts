import { Scene } from "./Scene"
import { Entity } from "../entities/Entity"
import { Worm } from "../entities/Worm"
import { Wall, findWallAt, isPointBlocked, type WallLookup } from "../entities/Wall"
import { Star } from "../entities/Star"
import { Bubble } from "../entities/Bubble"
import { SpeedBubble } from "../entities/SpeedBubble"
import { RevealSwitch } from "../entities/RevealSwitch"
import { EnemyWorm } from "../entities/EnemyWorm"
import { GuardWorm, type GuardTarget } from "../entities/GuardWorm"
import { Nest } from "../entities/Nest"
import { Ant } from "../entities/Ant"
import { Frog } from "../entities/Frog"
import { SaveButton } from "../entities/SaveButton"
import { LevelDoorMarker } from "../entities/LevelDoorMarker"
import { Sky } from "../entities/Sky"
import { Water } from "../entities/Water"
import { Pond } from "../entities/Pond"
import { Material, type MaterialKind } from "../entities/Material"
import { BridgeSlot } from "../entities/BridgeSlot"
import { BigBranch } from "../entities/BigBranch"
import { Checkpoint } from "../entities/Checkpoint"
import { LilyPad } from "../entities/LilyPad"
import { Key } from "../entities/Key"
import { SubmergedPassage } from "../entities/SubmergedPassage"
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
  FOG_LIGHT_RADIUS_SMOOTHING,
  FOG_SOFT_EDGE,
  FOG_SIZE_MULTIPLIER,
  REVEAL_DURATION,
  NEST_STORAGE_RADIUS,
  NEST_SCATTER_MIN,
  NEST_SCATTER_RANGE,
  STEAL_COOLDOWN_AFTER_DROP,
  ENEMY_NEST_SPAWN_RADIUS,
  POND_START_RATIO,
  POND_WIDTH_RATIO,
  POND_HEIGHT,
  BRIDGE_SLOT_COUNT,
  POND_MATERIAL_COUNT,
  MATERIAL_SIZE,
  POND_DROWN_GRACE,
  FROG_FOCUS_ZOOM_SCALE,
  FROG_EDGE_MARGIN,
  VERTICAL_WATER_HEIGHT_MULTIPLIER,
  LILY_PAD_COUNT,
  LILY_PAD_SURFACE_BAND_HEIGHT,
  SUBMERGED_PASSAGE_WIDTH,
  SUBMERGED_PASSAGE_HEIGHT,
  SUBMERGED_PASSAGE_BOTTOM_MARGIN,
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

  // -------------------------------------------------------------------------
  // Perf (hotfix/gameplay-performance): раньше update() каждый кадр заново
  // проходил ВЕСЬ this.entities (на уровне копания это могут быть сотни
  // стен) через .filter()/.find() по instanceof, чтобы достать нужные
  // подмножества — стены, звёзды, пузырьки, врагов и т.д. Теперь addEntity()/
  // removeEntity() сразу раскладывают сущность по нужным индексам (см.
  // indexEntity/unindexEntity ниже), а update() их просто читает — без
  // единого прохода по всему списку сущностей за кадр.
  // -------------------------------------------------------------------------
  private walls: Wall[] = []
  /** По networking cellKey (см. Wall.cellKey, только levels 0/1) — служит и
   * для применения чужих ударов (wallUpdated/applyLevelDiff), и как O(1)
   * пространственный индекс "какая стена под этой точкой" (см. wallLookup/
   * cellKeyFor ниже — тот же формат ключа, каким стена регистрирует себя
   * при создании в generateNextLevel). */
  private readonly wallByCellKey = new Map<string, Wall>()
  /** Стены, ударенные в этом кадре (см. Wall.onDirty, выставляется прямо из
   * Wall.hit()) — раз в кадр вычерпывается для репорта в сеть (см. update()),
   * вместо сканирования всех this.walls в поисках justHit. */
  private readonly dirtyWalls = new Set<Wall>()
  private stars: Star[] = []
  private readonly starsById = new Map<string, Star>()
  private bubbles: Bubble[] = []
  private readonly bubblesById = new Map<string, Bubble>()
  private speedBubbles: SpeedBubble[] = []
  private readonly speedBubblesById = new Map<string, SpeedBubble>()
  private revealSwitches: RevealSwitch[] = []
  private readonly revealSwitchesById = new Map<string, RevealSwitch>()
  private guards: GuardWorm[] = []
  private enemies: EnemyWorm[] = []
  private materials: Material[] = []
  private readonly materialsById = new Map<string, Material>()
  private bridgeSlots: BridgeSlot[] = []
  private readonly bridgeSlotsById = new Map<string, BridgeSlot>()
  private bigBranch: BigBranch | null = null
  private nest: Nest | null = null
  /** Чекпоинт/пруд уровня 3 (индекс 2) — по одному на сегмент, читаются
   * каждый кадр для муравья (см. update()), та же логика кэширования, что и
   * у bigBranch/nest выше. */
  private checkpoint: Checkpoint | null = null
  private pond: Pond | null = null
  /** Кнопка(и) сохранения — обычно одна на сегмент, но массив (а не
   * singleton, как у checkpoint/pond выше), т.к. на стыке уровней старая
   * ещё может на мгновение сосуществовать с новой (см. комментарий у
   * оригинального entities.filter(SaveButton) — тот же принцип). */
  private saveButtons: SaveButton[] = []
  /** Сущности, которым реально нужен update() каждый кадр — то есть НЕ
   * статичные декорации/предметы (у Wall/Star/Bubble/SpeedBubble/
   * RevealSwitch/BridgeSlot/Material/Nest/SaveButton/LevelDoorMarker/Sky/
   * Water/Pond/BigBranch update() всегда пуст, см. соответствующие классы):
   * вражеские черви, страж и сами игроки (активный + напарники — из них
   * реально обновляется только активный, остальные тут просто пропускаются
   * по ссылке, но это уже проверка на маленьком списке в несколько
   * элементов, а не проход по всем стенам/звёздам уровня). */
  private dynamicEntities: Entity[] = []
  /** O(1)-поиск стены "под точкой" для Worm/EnemyWorm/GuardWorm (см.
   * entities/Wall.ts:WallLookup) — тот же wallByCellKey выше, обёрнутый под
   * их интерфейс. Строится один раз (замыкание над this), а не заново
   * каждый кадр. */
  private readonly wallLookup: WallLookup = {
    get: (x, y) => {
      const wall = this.wallByCellKey.get(this.cellKeyFor(x, y))
      return wall && wall.container.visible ? wall : undefined
    },
  }

  private activePlayer!: any
  private deathTimer = 0

  /** Пауза из меню (см. setPaused/PauseMenu) — блокирует ЛОКАЛЬНОЕ
   * управление/взаимодействие активного игрока с миром (см. update()), но
   * не трогает syncNetwork/обработку широковещательных событий/ИИ врагов и
   * стража — в co-op хост и на паузе обязан продолжать считать общий мир
   * для партнёра, иначе у того тоже всё замрёт. */
  private paused = false

  /** true после Scene.destroy() (см. onDestroy ниже) — нужен исключительно
   * для того, чтобы прервать уже запущенные асинхронные цепочки (startCoopLevel/
   * startCoopFrogLevel/prepareWaterSegment, все — await сети) ПОСЛЕ того, как
   * сцену уже уничтожили (например, React StrictMode синхронно
   * размонтирует-и-тут-же-монтирует заново в dev, а initialize()/сетевые
   * await ещё не успели резолвиться). Без этой проверки такая цепочка
   * продолжает выполняться уже ПОСЛЕ Engine.destroy() и падает, пытаясь
   * тронуть уже уничтоженные PIXI-объекты (например, this.fogSprite.texture,
   * которая после destroy() становится null, хотя сам fogSprite ещё
   * существует как JS-объект). */
  private destroyed = false

  protected onDestroy(): void {
    this.destroyed = true
  }

  // Co-op: напарник — точно такой же Worm/Ant, что и локальный игрок (не
  // отдельный "призрак"-класс), просто его позицией управляет не InputManager,
  // а сетевой снапшот (см. syncNetwork/GameNetworkStore.getRemotePlayerStates).
  // В single player этот стор всегда в режиме "solo", и вся секция ниже —
  // no-op (см. syncNetwork: ранний return, если mode !== "coop").
  private readonly network = GameNetworkStore.getInstance()
  private readonly remoteEntities = new Map<string, { entity: Worm | Ant | Frog; form: PlayerForm }>()
  /** network.isHost() на прошлом кадре — null, пока ещё ни разу не
   * замерялось (сразу после входа в комнату). Нужно только чтобы поймать
   * МОМЕНТ перехода false -> true (прежний хост вышел, мы стали первым по
   * RoomInfo.players) и один раз передать симуляцию врагов себе — см.
   * processSharedLevelEvents. */
  private wasHost: boolean | null = null
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
  // Уровень 3 (индекс 2) — пруд/мост: id и вид материала, который СЕЙЧАС
  // несёт активный игрок в щелепах (null — ничего не несёт). Устанавливается/
  // сбрасывается вместе с Ant.setCarriedMaterial() — см. tryGrabMaterial/
  // tryInstallMaterial/releaseCarriedMaterial в update().
  private carriedMaterialId: string | null = null
  private carriedMaterialKind: MaterialKind | null = null
  // Сколько секунд подряд муравей уже касается пруда без моста под ногами —
  // см. POND_DROWN_GRACE: реальное утопление срабатывает не в первый же
  // кадр касания, а после этой небольшой отсрочки (см. update()).
  private pondUnsafeTimer = 0
  // Последняя точка (мировые координаты), с которой респавнится муравей
  // после утопления на уровне 3 — не рестартит весь уровень/комнату (см.
  // respawnAntAtCheckpoint), обновляется каждым касанием Checkpoint.
  private lastCheckpointX = 0
  private lastCheckpointY = 0
  // Ширина/высота уровня 3 (пруд), общая для комнаты — тот же принцип, что и
  // roomLevelWidth/Height у уровней 0/1 (см. комментарий там), но отдельное
  // поле: уровни 2+ используют фиксированный шаг window.innerWidth на КАЖДЫЙ
  // переход между сегментами (см. update()), а roomLevelWidth/Height — это
  // совсем другой (увеличенный под подземное копание) размер, мешать их
  // нельзя. 0 — ещё не согласовано с сервером (co-op) — тогда generateNextLevel
  // сама подставляет window.innerWidth/Height по умолчанию.
  private pondLevelWidth = 0
  private pondLevelHeight = 0

  // Уровень 3 (жаба, единственный водный уровень — большой вертикальный
  // водоём) — тот же принцип, что и pondLevelWidth/Height выше (свой размер,
  // не связанный с диг-уровнями), только высота ЗАМЕТНО больше обычного
  // экрана (см. VERTICAL_WATER_HEIGHT_MULTIPLIER) — есть куда всплывать/
  // нырять. Вход в сам уровень 3 по-прежнему независим у каждого игрока (см.
  // shared/game-protocol.ts WaterSegmentState) — каждый клиент сам просит
  // канонический размер/seed у сервера, когда до него доплывает (см.
  // prepareWaterSegment). 0 — ещё не согласовано (co-op) или single player —
  // тогда generateNextLevel подставляет запасной window.innerWidth/Height * множитель.
  private waterLevelWidth = 0
  private waterLevelHeight = 0
  /** true, пока идёт (единственный) запрос ensureWaterSegment для очередного
   * сегмента — тот же принцип, что и pendingAdvanceLevel, только это не
   * ожидание широковещательного события (партнёр может быть на совсем
   * другом сегменте), а просто свой собственный round-trip до сервера. */
  private pendingWaterSegment = false
  /** true, как только КТО-ТО (в single player — только сам игрок) нашёл ключ
   * на уровне 3 — открывает SubmergedPassage навсегда (см. update()). */
  private keyFound = false
  /** Не даёт requestWaterPassageEnter уйти повторно каждый кадр, пока сервер
   * не ответил широковещательным waterPassageEntered (тот же принцип, что и
   * pendingWaterSegment выше). */
  private pendingWaterPassageEnter = false
  /** RoomLevelState уровня 4, уже присланный сервером вместе с
   * waterPassageEntered (co-op) — handleMetamorphosis (TRANSFORM, Frog ->
   * Worm) применяет его вместо локальной генерации, чтобы оба игрока
   * получили один и тот же seed/размер уровня 4. null в single player —
   * там уровень 4 просто генерируется на месте, без сервера. */
  private pendingLevel4State: RoomLevelState | null = null
  /** Тот же принцип, что и pendingWaterSegment/pendingWaterPassageEnter —
   * держит TRANSFORM (Frog -> Worm) от повторного запуска new Worm()/
   * generateNextLevel(4) на каждом кадре, пока грузится спрайт нового червяка
   * (см. Worm.init() — асинхронный, в отличие от Ant/Frog). */
  private pendingWormInit = false

  // Туман войны: вокруг червя — светлый круг, дальше — темнота. Копаем вслепую.
  private fogContainer = new Container()
  private fogSprite?: Sprite
  private fogSize = 3000
  private readonly baseLightRadius = FOG_BASE_LIGHT_RADIUS
  // lightRadius — то, что реально нарисовано на экране прямо сейчас;
  // targetLightRadius — то, к чему он плавно едет (updateLightRadius). Пузырёк
  // света просто сдвигает цель, а не радиус напрямую — иначе свет прыгал бы
  // мгновенно, как раньше.
  private lightRadius = this.baseLightRadius
  private targetLightRadius = this.baseLightRadius
  private readonly lightRadiusSmoothing = FOG_LIGHT_RADIUS_SMOOTHING
  private readonly lightRadiusPerBubble = FOG_LIGHT_RADIUS_PER_BUBBLE
  private readonly lightSoftEdge = FOG_SOFT_EDGE
  // Радиус, "запечённый" в текущую текстуру тумана (buildFogTexture). Между
  // перестройками текстуры (редкими: старт/рестарт уровня, догоняющий
  // снапшот) реальный рост радиуса от пузырьков рисуем просто масштабом
  // fogSprite = lightRadius / fogTextureRadius — на порядок дешевле, чем
  // перерисовывать многотысячный canvas на каждый кадр анимации.
  private fogTextureRadius = this.baseLightRadius

  // Факел-выключатель: подобрал — минуту вся карта видна без тумана.
  private readonly revealDuration = REVEAL_DURATION
  private revealTimer = 0

  // Пузырёк скорости: подобрал — на SPEED_BOOST_DURATION секунд
  // в SPEED_BOOST_MULTIPLIER раз быстрее ходишь. speedText виден только
  // пока действует (как revealText).
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

  /** starId, для которых наш собственный запрос на подбор уже в полёте (см.
   * tryPickupStar) — не даёт слать повторный starPickup КАЖДЫЙ кадр, пока
   * игрок продолжает касаться звезды, а ответ ещё не пришёл. Всегда пуст в
   * solo (там подбор мгновенный, локальный, без сети). */
  private readonly pendingStarPickups = new Set<string>()

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
    this.carriedMaterialId = null
    this.carriedMaterialKind = null
    this.lightRadius = this.baseLightRadius
    this.targetLightRadius = this.baseLightRadius
    this.revealTimer = 0
    this.speedBoostTimer = 0
    this.pendingAdvanceLevel = false
    this.pendingRoomRestart = false
    this.pendingWaterSegment = false
    this.keyFound = false
    this.pendingWaterPassageEnter = false
    this.pendingLevel4State = null
    this.pendingWormInit = false
    this.lastCarriedStarByEnemy.clear()
    // Рестарт/reconnect — все запросы, отправленные ДО этого момента,
    // относятся к уже неактуальному уровню/эпохе; их ack (если ещё придёт)
    // будет отброшен в tryPickupStar по несовпадению levelIndex/roomEpoch,
    // но сам факт "в полёте" тут ничего больше не должен блокировать.
    this.pendingStarPickups.clear()
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
    // Комната уже прошла подводный проход (кто-то из игроков открыл его
    // раньше нас — см. LevelStateService.enterWaterPassage) — level уровня 4
    // сервер к этому моменту уже держит как обычный RoomLevelState (levelByRoom),
    // поэтому ensureLevel(0, ...) ниже (который просто вернул бы ЕГО же) не
    // нужен: сразу спавним честным червяком на уровне 4, минуя всю
    // кат-сцену/воду целиком — тот же принцип "прыжок сразу на актуальный
    // прогресс", что и у frogProgress ниже.
    const existingLevelState = this.network.getLevelState()
    if (existingLevelState?.level === 4) {
      await this.startCoopWormLevel4(existingLevelState)
      return
    }

    // Late-join/reconnect, когда МЫ САМИ (по своему playerId, см.
    // JoinRoomAck.frogProgress) уже доплывали до воды — сразу жаба на
    // актуальном сегменте, минуя кат-сцену метаморфозы и всю диг/пруд-фазу
    // целиком (тот же принцип, что и loadSavedLevel() в single player —
    // прыжок сразу на сохранённый уровень без повторного прохождения пути).
    // Уровни 0/1/2 всегда лок-степ (см. RoomLevelState) — если МЫ уже были
    // на воде, значит их мы уже честно прошли, повторно проходить незачем.
    const frogProgress = this.network.getFrogProgress()
    if (frogProgress !== null && frogProgress >= 3) {
      await this.startCoopFrogLevel(frogProgress)
      return
    }
    // Сцену успели уничтожить, пока мы ждали сеть выше (см. onDestroy) —
    // дальше трогать PIXI-объекты уже небезопасно, прерываемся.
    if (this.destroyed) return

    this.currentLevelXOffset = 0
    this.worldContainer.position.set(0, 0)

    let levelState = this.network.getLevelState()
    if (!levelState) {
      levelState = await this.network.ensureLevel(0, this.digLevelWidth(), this.digLevelHeight())
      if (this.destroyed) return
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
    // Late-joiner на уровне 2 должен генерировать пруд/мост на ТОЙ ЖЕ
    // абсолютной X, что и партнёр, который дошёл туда пешком (тот копит
    // currentLevelXOffset по window.innerWidth за каждый пройденный
    // горизонтальный сегмент, см. переход 1->2 в update()) — иначе пруд,
    // слоты и материалы окажутся у двух клиентов в разных мировых
    // координатах, хотя id и seed совпадают. Та же формула, что и в
    // single-player "startLevel >= 1" ветке onCreate() выше.
    this.currentLevelXOffset = this.levelIndex >= 1 ? (this.levelIndex - 1) * window.innerWidth : 0

    if (this.levelIndex >= 1) {
      // Late-joiner застал партнёра уже на уровне 1/2 — сразу муравей на
      // линии травы, как и при обычном локальном "startLevel >= 1" (см. выше).
      this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)
      this.applyLevelDiff(levelState)

      const antX = this.currentLevelXOffset + window.innerWidth / 2
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

  /**
   * Late-join/reconnect прямо на воду (level >= 3) — см. вызов в
   * startCoopLevel() выше. Диг-фазу (уровни 0/1/2) мы уже честно прошли
   * раньше (иначе не оказались бы жабой), генерировать её заново незачем —
   * сразу узнаём канонический сегмент level у сервера и спавним жабу на нём,
   * без кат-сцены метаморфозы (тот же принцип, что и у "startLevel >= 1" в
   * single player onCreate() — прыжок сразу на сохранённый прогресс).
   *
   * roomLevelHeight (для Y-смещения между диг-фазой и поверхностью) сервер
   * к этому моменту уже мог "забыть" (RoomLevelState — один слот на комнату,
   * перезаписывается при каждом advance, а мы могли уйти на воду задолго до
   * этого реконнекта) — используем собственный digLevelHeight() как разумное
   * приближение, тот же фолбэк, что и в ветке "сеть подвела" чуть выше.
   */
  private async startCoopFrogLevel(level: number): Promise<void> {
    this.roomLevelHeight = this.digLevelHeight()
    this.currentLevelYOffset = -this.roomLevelHeight

    await this.prepareWaterSegment(level)
    if (this.destroyed) return

    // Та же формула, что и у late-join на уровень 1/2 выше (свой собственный
    // viewport, а не канонический waterLevelWidth — см. комментарий там).
    this.currentLevelXOffset = (level - 1) * window.innerWidth
    this.levelIndex = level

    this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)
    this.applyWaterLevelCatchUp()

    // Жаба всплывает/ныряет по вертикали в этом (единственном, заметно более
    // высоком) водном уровне — спавнится у самого дна, у подводного прохода,
    // а не по центру: та же логика, что и в handleMetamorphosis (Ant -> Frog).
    const frogY = this.currentLevelYOffset + this.waterLevelHeight - SUBMERGED_PASSAGE_HEIGHT - SUBMERGED_PASSAGE_BOTTOM_MARGIN - 60
    const frogX = this.currentLevelXOffset + window.innerWidth / 2
    const frog = new Frog(this.input, frogX, frogY)
    this.activePlayer = frog
    this.addEntity(frog)

    this.worldContainer.scale.set(this.frogFocusZoomScale)
    this.worldContainer.pivot.set(frogX, frogY)
    this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
  }

  /**
   * Late-join/reconnect, когда комната уже открыла подводный проход и
   * перешла на уровень 4 (см. проверку в startCoopLevel выше) — сразу честный
   * червяк на уровне 4, минуя всю кат-сцену/воду/подземелье целиком. Точное
   * X/Y-смещение уровня 4 (зависящее от того, какой реальной высоты был
   * пройденный уровень 3 у ПЕРВОГО игрока, открывшего проход) не восстановить
   * без честного прохождения — ставим новый, заведомо свободный от всего
   * остального блок координат, тем же принципом "разумного приближения", что
   * и у startCoopFrogLevel выше.
   */
  private async startCoopWormLevel4(levelState: RoomLevelState): Promise<void> {
    this.prepareRoomLevel(levelState, this.network.getEpoch())
    this.currentLevelYOffset = -(this.digLevelHeight() * 2 + window.innerHeight * VERTICAL_WATER_HEIGHT_MULTIPLIER)
    this.currentLevelXOffset = 0

    this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)

    const worm = new Worm(this.input)
    this.activePlayer = worm

    await worm.init()
    if (this.destroyed) return

    worm.container.x = this.currentLevelXOffset + this.roomLevelWidth / 2
    worm.container.y = this.currentLevelYOffset + 60
    this.addEntity(worm)

    this.worldContainer.scale.set(this.wormFocusZoomScale)
    this.worldContainer.pivot.set(worm.container.x, worm.container.y)
    this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
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
    if (levelState.level <= 1) {
      this.roomLevelWidth = levelState.width
      this.roomLevelHeight = levelState.height
    } else if (levelState.level === 2) {
      // Отдельные поля — см. комментарий у pondLevelWidth/Height выше:
      // размер уровня 2 не связан с увеличенным digLevelWidth/Height 0/1.
      this.pondLevelWidth = levelState.width
      this.pondLevelHeight = levelState.height
    } else if (levelState.level === 4) {
      // level === 4 переиспользует те же поля, что и 0/1 (см. комментарий у
      // width/height в generateNextLevel) — тот же digLevelWidth()/Height()
      // принцип синхронизации размера для co-op.
      this.roomLevelWidth = levelState.width
      this.roomLevelHeight = levelState.height
    }
    this.roomEpoch = epoch
    this.levelIndex = levelState.level
  }

  /**
   * Co-op: узнаёт у сервера канонический seed/размер водного сегмента level
   * (см. shared/game-protocol.ts WaterSegmentState) — первый из клиентов,
   * кто до него доплыл, закрепляет их, второй просто получает готовые (тот
   * же принцип, что и ensureLevel/prepareRoomLevel, но БЕЗ единой "двери":
   * прогресс на воде независим у каждого игрока, см. GameNetworkStore.
   * ensureWaterSegment). В single player — мгновенный no-op (сети нет),
   * waterLevelWidth/Height остаются 0, и generateNextLevel сама подставляет
   * window.innerWidth/Height — ноль изменений поведения соло.
   */
  private async prepareWaterSegment(level: number): Promise<void> {
    if (this.network.getSnapshot().mode !== "coop") return

    const preferredHeight = this.waterLevelHeight || window.innerHeight * VERTICAL_WATER_HEIGHT_MULTIPLIER
    const segment = await this.network.ensureWaterSegment(level, this.waterLevelWidth || window.innerWidth, preferredHeight)
    if (!segment) return

    this.waterLevelWidth = segment.width
    this.waterLevelHeight = segment.height
    this.rng = createRng(segment.seed)
  }

  /**
   * Уровень 3 (co-op) — накладывает уже собранные (кем угодно) кувшинки/ключ/
   * статус прохода на только что сгенерированную (из общего seed) карту —
   * тот же принцип, что и applyLevelDiff для уровней 0/1/2, только источник —
   * WaterSegmentState (см. GameNetworkStore.getWaterLevelState), а не
   * RoomLevelState. Вызывается сразу после generateNextLevel(3, ...) в co-op —
   * иначе поздний/переподключившийся игрок собирал бы уже найденный
   * партнёром ключ заново. В single player getWaterLevelState() всегда null —
   * безопасный no-op.
   */
  private applyWaterLevelCatchUp(): void {
    const state = this.network.getWaterLevelState()
    if (!state || state.level !== this.levelIndex) return

    if (state.collectedItemIds.length > 0) {
      const collectibles = this.entities.filter((e): e is LilyPad | Key => e instanceof LilyPad || e instanceof Key)
      for (const id of state.collectedItemIds) {
        const item = collectibles.find((e) => e.id === id)
        if (item) item.container.visible = false
      }
    }

    this.keyFound = state.keyFound
    if (state.keyFound) {
      const passages = this.entities.filter((e): e is SubmergedPassage => e instanceof SubmergedPassage)
      for (const passage of passages) passage.open()
    }
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
    for (const [cellKey, hits] of Object.entries(levelState.wallHits)) {
      this.wallByCellKey.get(cellKey)?.applyRemoteHits(hits)
    }

    for (const id of levelState.collectedItemIds) {
      const item = this.starsById.get(id) ?? this.bubblesById.get(id) ?? this.speedBubblesById.get(id) ?? this.revealSwitchesById.get(id)
      if (item) item.container.visible = false
    }

    // Это догоняющий снапшот при входе/реконнекте, а не живой подбор пузырька
    // — тут уместен мгновенный скачок без анимации, targetLightRadius сразу
    // синхронизируем, чтобы updateLightRadius не начал "доезжать" из старого значения.
    this.lightRadius = this.baseLightRadius + levelState.lightRadiusBonus
    this.targetLightRadius = this.lightRadius
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

    if (levelState.level === 2) {
      this.applyPondLevelDiff(levelState)
    }

    this.updateHud()
  }

  /** Часть applyLevelDiff, специфичная для уровня 3 (индекс 2, пруд/мост) —
   * см. комментарий у RoomLevelState.materialCarriers/bridgeSlots/bigBranch. */
  private applyPondLevelDiff(levelState: RoomLevelState): void {
    const localPlayerId = this.network.getSnapshot().localPlayerId

    for (const [materialId, carrierId] of Object.entries(levelState.materialCarriers)) {
      const material = this.materialsById.get(materialId)
      if (material) material.container.visible = false

      if (carrierId === localPlayerId) {
        this.carriedMaterialId = materialId
        this.carriedMaterialKind = material?.kind ?? null
        if (this.activePlayer instanceof Ant) this.activePlayer.setCarriedMaterial(this.carriedMaterialKind)
      }
    }

    for (const [slotId, materialId] of Object.entries(levelState.bridgeSlots)) {
      const slot = this.bridgeSlotsById.get(slotId)
      const material = this.materialsById.get(materialId)
      if (slot && material && !slot.isInstalled) {
        slot.install(materialId, material.kind)
        material.container.visible = false
      }
    }

    const bigBranch = this.bigBranch
    if (bigBranch) {
      // Хост сам продолжает считать прогресс локально (tick() в update()) —
      // навязывать ему setRemoteState нельзя, иначе он навсегда станет
      // "куклой" и перестанет симулировать собственную же ветку.
      if (!this.network.isHost()) {
        bigBranch.setRemoteState(levelState.bigBranch.progress)
      }

      if (levelState.bigBranch.progress >= 1 && !bigBranch.installed) {
        bigBranch.markInstalled()
        const finalSlot = this.bridgeSlots[this.bridgeSlots.length - 1]
        if (finalSlot && !finalSlot.isInstalled) finalSlot.install("bigBranch", "bigBranch")
      }
    }
  }

  // -------------------------------------------------------------------------
  // Уровни 0/1 (копание) — подбор звезды. Раньше эту логику вели Worm/Ant
  // прямо у себя в update() (сразу прятали звезду при столкновении), а
  // GameScene лишь ЗАМЕЧАЛ факт по diff'у видимости (starsVisibleBefore,
  // пересоздаваемому Map'ом каждый кадр) — единственная точка подбора теперь
  // тут, вызывается из update() при столкновении активного игрока со звездой.
  // -------------------------------------------------------------------------

  /**
   * true, если пройденный за этот кадр отрезок (prevX, prevY) -> текущая
   * позиция активного игрока прошёл достаточно близко к звезде, чтобы
   * засчитать касание — не только "звезда содержит конечную точку", как у
   * обычного isColliding(). Без этого при просадке кадра (см. комментарий у
   * вызова) игрок мог целиком перепрыгнуть маленький хитбокс звезды за один
   * шаг update(), ни разу не пересекшись с ней в итоговой позиции.
   * "Радиус" игрока тут — грубая оценка (половина меньшей стороны его
   * рамки), а не точный AABB, но для маленькой круглой звезды этого более
   * чем достаточно и намного дешевле честного отрезок-против-прямоугольника.
   */
  private isPlayerPathNearStar(prevX: number, prevY: number, star: Star): boolean {
    const player = this.activePlayer
    const curX = player.container.x
    const curY = player.container.y

    const dx = curX - prevX
    const dy = curY - prevY
    const lengthSq = dx * dx + dy * dy

    // t — проекция звезды на отрезок движения, зажатая в [0, 1] (0 — старт
    // кадра, 1 — конец); при lengthSq === 0 игрок не двигался вовсе, и
    // ближайшая точка отрезка — просто его единственная точка.
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((star.container.x - prevX) * dx + (star.container.y - prevY) * dy) / lengthSq)) : 0

    const closestX = prevX + t * dx
    const closestY = prevY + t * dy

    const playerRadius = Math.min(player.width, player.height) / 2
    const hitRadius = star.width / 2 + playerRadius

    return Math.hypot(star.container.x - closestX, star.container.y - closestY) <= hitRadius
  }

  /**
   * В single player сразу и без сети засчитывает звезду. В co-op прячет её
   * ОПТИМИСТИЧНО (не дожидаясь ответа) и просит сервер подтвердить — если
   * он говорит "уже забрали" (alreadyCollected), оставляем скрытой и просто
   * подтягиваем актуальный общий счёт; если ack не пришёл вовсе (таймаут)
   * или сообщает про устаревший level/эпоху — откатываем звезду обратно
   * видимой, раз сервер её подбор не подтвердил. pendingStarPickups не даёт
   * слать повторный запрос на КАЖДОМ кадре, пока ответ ещё не пришёл, а
   * игрок продолжает стоять на звезде.
   */
  private tryPickupStar(star: Star): void {
    if (!star.container.visible || this.pendingStarPickups.has(star.id)) return

    if (this.network.getSnapshot().mode !== "coop") {
      star.container.visible = false
      this.collectedStars += 1
      if (this.activePlayer instanceof Ant) this.activePlayer.showLeafPickupEffect()
      this.updateHud()
      return
    }

    const level = this.levelIndex
    const epoch = this.roomEpoch

    this.pendingStarPickups.add(star.id)
    star.container.visible = false
    if (this.activePlayer instanceof Ant) this.activePlayer.showLeafPickupEffect()

    this.network.requestStarPickup(level, star.id).then((ack) => {
      this.pendingStarPickups.delete(star.id)

      if (ack.ok) {
        // Общий счёт/HUD обновит широковещательный starCollected (см.
        // processSharedLevelEvents/drainStarCollected) — он приходит и
        // самому отправителю, не только напарнику, так что тут больше
        // ничего делать не нужно.
        return
      }

      if (ack.alreadyCollected) {
        // Напарник забрал её первым — звезда и так уже скрыта (мы сами
        // спрятали её оптимистично выше), просто подстраховываем общий
        // счёт на случай, если широковещательный starCollected от напарника
        // почему-то ещё не дошёл.
        if (typeof ack.teamStars === "number") this.network.reconcileTeamStars(ack.teamStars)
        return
      }

      // Таймаут или устаревший level/epoch (например, комната успела
      // перезапуститься/перейти дальше, пока ответ шёл) — откатываем
      // локальный оптимистичный подбор, раз сервер его не подтвердил. Только
      // если мы всё ещё на том же уровне/эпохе — иначе эта Star могла уже
      // быть удалена из мира вовсе (см. clearEntityIndices), возвращать её
      // видимой незачем и может быть небезопасно.
      if (this.levelIndex === level && this.roomEpoch === epoch) {
        star.container.visible = true
      }
    })
  }

  // -------------------------------------------------------------------------
  // Уровень 3 (индекс 2) — пруд/мост: подбор/установка материала, утопление,
  // респавн на чекпоинте. См. RoomLevelState.materialCarriers/bridgeSlots/
  // bigBranch и GameNetworkStore.requestMaterialGrab/Install/Release.
  // -------------------------------------------------------------------------

  /** Пытается подобрать материал — в single player сразу локально, в co-op
   * просит сервер клеймить (результат применится широковещательно через
   * drainMaterialUpdates/applyMaterialGrabbed, включая нас самих). */
  private tryGrabMaterial(material: Material): void {
    if (this.carriedMaterialKind) return

    if (this.network.getSnapshot().mode === "coop") {
      void this.network.requestMaterialGrab(this.levelIndex, material.id)
      return
    }

    this.applyMaterialGrabbed(material.id, true)
  }

  /** Применяет "материал подобран" — и для своего клейма (isLocal), и для
   * чужого (просто прячет материал, ничего в своём состоянии не меняет). */
  private applyMaterialGrabbed(materialId: string, isLocal: boolean): void {
    const material = this.materialsById.get(materialId)
    if (!material || !material.container.visible) return // уже подобран/установлен кем-то

    material.container.visible = false

    if (isLocal) {
      this.carriedMaterialId = materialId
      this.carriedMaterialKind = material.kind
      if (this.activePlayer instanceof Ant) this.activePlayer.setCarriedMaterial(material.kind)
      this.updateHud()
    }
  }

  /** Материал снова свободен (утонул носитель) — возвращаем его видимым на
   * то же (исходное) место, координаты никогда не менялись. */
  private applyMaterialReleased(materialId: string): void {
    const material = this.materialsById.get(materialId)
    if (material) material.container.visible = true
  }

  /** Носитель утонул или иначе потерял материал — снимает клейм (в co-op —
   * на сервере, широковещательно; в single player — сразу локально) и чистит
   * собственное состояние переноса. */
  private releaseCarriedMaterial(): void {
    if (!this.carriedMaterialId) return
    const materialId = this.carriedMaterialId

    this.carriedMaterialId = null
    this.carriedMaterialKind = null
    if (this.activePlayer instanceof Ant) this.activePlayer.setCarriedMaterial(null)
    this.updateHud()

    if (this.network.getSnapshot().mode === "coop") {
      this.network.requestMaterialRelease(this.levelIndex, materialId)
    } else {
      this.applyMaterialReleased(materialId)
    }
  }

  /** Пытается установить материал, который сейчас несёт активный игрок, в
   * слот моста — тот же принцип асинхронного применения, что и tryGrabMaterial. */
  private tryInstallMaterial(material: Material, slot: BridgeSlot): void {
    if (slot.isInstalled || slot.accepts !== "material") return

    if (this.network.getSnapshot().mode === "coop") {
      void this.network.requestMaterialInstall(this.levelIndex, material.id, slot.id)
      return
    }

    this.applyMaterialInstalled(material.id, slot.id)
  }

  /** Окончательно ставит материал в слот — необратимо, освобождает носителя
   * (если это были мы). */
  private applyMaterialInstalled(materialId: string, slotId: string): void {
    const slot = this.bridgeSlotsById.get(slotId)
    const material = this.materialsById.get(materialId)
    if (!slot || !material || slot.isInstalled) return

    slot.install(materialId, material.kind)
    material.container.visible = false

    if (this.carriedMaterialId === materialId) {
      this.carriedMaterialId = null
      this.carriedMaterialKind = null
      if (this.activePlayer instanceof Ant) this.activePlayer.setCarriedMaterial(null)
      this.updateHud()
    }
  }

  /** Топит активного муравья: роняет то, что он нёс, и запускает
   * Ant.drown() — respawn на чекпоинте случится позже, из блока смерти в
   * update(), когда истечёт DEATH_RESTART_DELAY после diedFromDrowning. */
  private drownActivePlayer(ant: Ant): void {
    this.releaseCarriedMaterial()
    ant.drown()
  }

  /** Респавнит нового муравья на последнем чекпоинте вместо перезапуска
   * всего уровня/комнаты — Pond/BridgeSlot/Material/BigBranch не трогаются,
   * прогресс моста и материалы остаются как были. */
  private respawnAntAtCheckpoint(): void {
    const dead = this.activePlayer
    if (dead) {
      this.worldContainer.removeChild(dead.container)
      this.entities = this.entities.filter((e) => e !== dead)
      this.unindexEntity(dead)
    }

    const ant = new Ant(this.input, this.lastCheckpointX, this.lastCheckpointY)
    this.activePlayer = ant
    this.addEntity(ant)

    this.worldContainer.scale.set(this.antFocusZoomScale)
    this.worldContainer.pivot.set(ant.container.x, ant.container.y)
    this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)

    this.deathTimer = 0
    this.pondUnsafeTimer = 0
  }

  /** Гость применяет состояние врагов, присланное хостом — вместо своего ИИ
   * (см. EnemyWorm.setRemoteState/GuardWorm.setRemoteState). */
  private applyEnemyNetStates(states: EnemyNetState[]): void {
    for (const state of states) {
      if (state.kind === "guard") {
        this.guards.find((g) => g.remoteId === state.id)?.setRemoteState(state)
        continue
      }

      this.enemies.find((e) => e.remoteId === state.id)?.setRemoteState(state)

      const prevCarried = this.lastCarriedStarByEnemy.get(state.id) ?? null
      this.lastCarriedStarByEnemy.set(state.id, state.carryingStarId)

      if (state.carryingStarId) {
        const star = this.starsById.get(state.carryingStarId)
        if (star) star.container.visible = false
      } else if (prevCarried) {
        // Только что перестал нести (подобрали обратно/донёс до домика на
        // стороне хоста) — показываем звезду снова у текущей позиции врага:
        // для доставки в домик это и есть фактическое место, для отбитой у
        // вора звезды — очень близко к месту падения.
        const star = this.starsById.get(prevCarried)
        if (star) {
          star.container.position.set(state.x, state.y)
          star.container.visible = true
        }
      }
    }
  }

  /** Оба игрока получили это широковещательно (включая того, кто дошёл до
   * двери/края уровня и попросил переход) — единственная точка, где реально
   * происходит переход 0->1 (копание, вертикально) или 1->2 (муравей выходит
   * к пруду, горизонтально) в co-op (см. GameNetworkStore.requestAdvanceLevel). */
  private applyLevelAdvanced(payload: LevelAdvancedPayload): void {
    this.pendingAdvanceLevel = false

    if (payload.levelState.level !== this.levelIndex + 1) {
      // Устаревшее/чужое событие (например, мы уже успели уйти дальше по
      // локальному прогрессу уровня 3+) — молча игнорируем.
      return
    }

    // 0->1 — вертикальный переход (копание, тот же мир продолжается выше);
    // 1->2 — горизонтальный (муравей выходит на новый сегмент с прудом),
    // та же прогрессия X, что и у локального (single player) перехода —
    // см. ветку levelIndex === 1 ниже в update().
    const isDigTransition = this.levelIndex === 0
    const previousHeight = this.roomLevelHeight

    // Тот же приём, что и в исходном локальном переходе: оставляем только
    // активного игрока и напарника, остальное (стены/предметы старого
    // уровня) регенерируется заново из нового seed. Полный сброс индексов +
    // переиндексация оставшихся (их всего 1-2) дешевле и надёжнее, чем
    // выборочно вычищать из каждого кэша по одной удалённой сущности.
    const kept = this.entities.filter((entity) => entity === this.activePlayer || this.isRemoteEntity(entity))
    this.clearEntityIndices()
    this.entities = kept
    for (const entity of kept) this.indexEntity(entity)
    this.worldContainer.removeChildren()
    if (this.activePlayer) this.worldContainer.addChild(this.activePlayer.container)
    for (const remote of this.remoteEntities.values()) this.worldContainer.addChild(remote.entity.container)

    if (isDigTransition) {
      // Абсолютная позиция игрока НЕ меняется (та же дверь, тот же шов между
      // уровнями) — сдвигаем только систему координат уровня, как и раньше.
      this.currentLevelYOffset -= previousHeight
    } else {
      this.currentLevelXOffset += window.innerWidth
    }

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
    for (const update of wallUpdates) {
      if (update.level !== level || update.epoch !== epoch) continue
      this.wallByCellKey.get(update.cellKey)?.applyRemoteHits(update.hits)
    }

    const starUpdates = this.network.drainStarCollected()
    if (starUpdates.length > 0) {
      let anyApplied = false
      for (const update of starUpdates) {
        if (update.level !== level || update.epoch !== epoch) continue
        const star = this.starsById.get(update.starId)
        if (star) star.container.visible = false
        anyApplied = true
      }
      if (anyApplied) this.updateHud()
    }

    const lightUpdates = this.network.drainLightUpdates()
    for (const update of lightUpdates) {
      if (update.level !== level || update.epoch !== epoch) continue
      const revealSwitch = this.revealSwitchesById.get(update.switchId)
      if (revealSwitch) revealSwitch.container.visible = false
      this.revealTimer = Math.max(0, (update.lightEndsAt - Date.now()) / 1000)
      if (this.revealText) {
        this.revealText.visible = this.revealTimer > 0
        this.revealText.text = `🔥 Карта видна: ${Math.ceil(this.revealTimer)}с`
      }
    }

    const boostUpdates = this.network.drainBoostUpdates()
    for (const update of boostUpdates) {
      if (update.level !== level || update.epoch !== epoch) continue

      if (update.kind === "light") {
        const bubble = this.bubblesById.get(update.bubbleId)
        if (bubble) bubble.container.visible = false
        // Сдвигаем только цель — сам lightRadius плавно доедет до неё в
        // updateLightRadius, без синхронной перестройки текстуры тумана тут же.
        this.targetLightRadius = this.baseLightRadius + update.lightRadiusBonus
      } else {
        const speedBubble = this.speedBubblesById.get(update.bubbleId)
        if (speedBubble) speedBubble.container.visible = false
        this.speedBoostTimer = Math.max(0, (update.speedBoostEndsAt - Date.now()) / 1000)
      }
    }

    // Уровень 3 (индекс 2, пруд/мост) — тот же принцип "накопили за кадр,
    // вычерпали один раз", см. комментарий у остальных drain* выше.
    const materialUpdates = this.network.drainMaterialUpdates()
    for (const update of materialUpdates) {
      if (update.level !== level || update.epoch !== epoch) continue
      if (update.carrierId) {
        this.applyMaterialGrabbed(update.materialId, update.carrierId === this.network.getSnapshot().localPlayerId)
      } else {
        this.applyMaterialReleased(update.materialId)
      }
    }

    const slotUpdates = this.network.drainSlotUpdates()
    for (const update of slotUpdates) {
      if (update.level !== level || update.epoch !== epoch) continue
      this.applyMaterialInstalled(update.materialId, update.slotId)
    }

    if (level === 2) {
      const bigBranch = this.bigBranch
      if (bigBranch && !this.network.isHost()) {
        const latestBigBranch = this.network.getLatestBigBranchState()
        if (latestBigBranch && latestBigBranch.level === level && latestBigBranch.epoch === epoch) {
          bigBranch.setRemoteState(latestBigBranch.progress)
        }
      }

      // И у хоста (после его собственного tick в основном update()), и у
      // гостя (сразу после setRemoteState выше) — как только прогресс достиг
      // 1, финальный слот должен стать платформой; идемпотентно на обеих
      // сторонах (BridgeSlot.install уже сам себя не даёт вызвать дважды).
      if (bigBranch && bigBranch.progress >= 1 && !bigBranch.installed) {
        bigBranch.markInstalled()
        const finalSlot = this.bridgeSlots.find((slot) => slot.accepts === "bigBranch")
        if (finalSlot && !finalSlot.isInstalled) finalSlot.install("bigBranch", "bigBranch")
      }
    }

    const isHostNow = this.network.isHost()

    if (!isHostNow) {
      // Интерполированное состояние (см. getInterpolatedEnemyStates), а не
      // сырое последнее — иначе враги у гостя дёргались бы/телепортировались
      // между редкими (раз в minEnemyStateIntervalMs) обновлениями от хоста.
      const latest = this.network.getInterpolatedEnemyStates()
      if (latest.length > 0) this.applyEnemyNetStates(latest)
    }

    if (this.wasHost === false && isHostNow) {
      // Прежний хост вышел (или мы им стали по другой причине), и теперь
      // первые по RoomInfo.players — мы. Подхватываем ИИ врагов/стража с их
      // ТЕКУЩИХ (уже отрисованных) позиций — сущности те же самые, что были
      // спавнены изначально из общего seed, никто не пересоздаётся и не
      // дублируется, просто раньше молчавший puppet-режим выключается.
      for (const enemy of this.enemies) enemy.resumeLocalControl()
      for (const guard of this.guards) guard.resumeLocalControl()

      this.bigBranch?.resumeLocalControl()
    }

    this.wasHost = isHostNow
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
    // зашёл первым с другим размером экрана. Уровень 2 (пруд/мост) — тот же
    // принцип, только отдельными полями (pondLevelWidth/Height): его размер —
    // всегда один "экран" (в отличие от увеличенных digLevelWidth/Height), и
    // 0 по умолчанию (single player/пока co-op ещё не согласовал) — тогда
    // подставляем обычный window.innerWidth/Height.
    // level === 4 — снова копание (жаба вернулась червяком через подводный
    // проход, см. update()/handleMetamorphosis) — переиспользует те же
    // roomLevelWidth/Height, что и уровни 0/1: тот же принцип синхронизации
    // размера для co-op (см. prepareRoomLevel), просто пересчитанные заново
    // (см. handleMetamorphosis) под актуальный digLevelWidth()/Height().
    const width =
      level <= 1 || level === 4
        ? this.roomLevelWidth
        : level === 2
          ? this.pondLevelWidth || window.innerWidth
          : this.waterLevelWidth || window.innerWidth
    // level === 3 — единственный водный уровень, заметно выше обычного
    // экрана (VERTICAL_WATER_HEIGHT_MULTIPLIER) — есть куда всплывать/нырять
    // (см. комментарий у VERTICAL_WATER_HEIGHT_MULTIPLIER в GameConfig.ts).
    const height =
      level <= 1 || level === 4
        ? this.roomLevelHeight
        : level === 2
          ? this.pondLevelHeight || window.innerHeight
          : this.waterLevelHeight || window.innerHeight * VERTICAL_WATER_HEIGHT_MULTIPLIER

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
      // вместо пустоты. Единственная преграда — один большой Pond по центру
      // сегмента (делит берега пополам, обойти нельзя), проходится только по
      // наведённому мосту (BridgeSlot × BRIDGE_SLOT_COUNT). Муравей ещё
      // муравей — метаморфоза в жабу только у ПРАВОГО края уровня (см.
      // update()), что естественно требует сперва достроить мост.
      //
      // Сбрасываем состояние переноса материала при каждой (пере)генерации
      // этого сегмента — GameScene живёт дольше одного прохождения уровня
      // (рестарт/повторный вход), а это поле иначе пережило бы его.
      this.carriedMaterialId = null
      this.carriedMaterialKind = null
      this.pondUnsafeTimer = 0

      this.addEntity(new Sky(startX, startY, width, this.grassLineY))

      // Пруд начинается заметно правее центра сегмента (см. POND_START_RATIO) —
      // сам центр (width/2) занят точкой спавна "продолжить с сохранения"/
      // позднего co-op подключения и кнопкой сохранения (обе — ниже по этому
      // же методу, координата startX + width/2), она должна остаться на
      // суше, а не оказаться внутри воды.
      //
      // Оба края округляем НАРУЖУ до границы клетки (this.cellSize) — трава
      // ниже пропускается по тому же тестовому x, каким рисуется её клетка
      // (шаг цикла — cellSize), так что нерокруглённый пруд оставлял бы
      // тёмную щель шириной до клетки там, где сам пруд уже кончился, а
      // трава ещё не началась (её клетка целиком пропущена из-за одной
      // точки старта внутри пруда).
      const rawPondLeft = startX + width * POND_START_RATIO
      const rawPondRight = rawPondLeft + width * POND_WIDTH_RATIO
      const pondLeft = startX + Math.floor((rawPondLeft - startX) / this.cellSize) * this.cellSize
      const pondRight = startX + Math.ceil((rawPondRight - startX) / this.cellSize) * this.cellSize
      const pondWidth = pondRight - pondLeft
      const pondTop = startY + this.grassLineY
      const isInsidePond = (x: number) => x >= pondLeft && x < pondRight

      for (let x = startX; x < startX + width + this.cellSize; x += this.cellSize) {
        // Клетки травы под прудом не рисуем — сам пруд встаёт поверх
        // отдельно ниже, одной сущностью на всю его ширину, а не по клеткам.
        if (!isInsidePond(x)) {
          this.addEntity(new Wall(x, startY + this.grassLineY, this.cellSize, this.cellSize, "grass"))
        }

        for (let y = startY + this.grassLineY + this.cellSize; y < startY + height; y += this.cellSize) {
          this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "dirt"))
        }
      }

      this.addEntity(new Pond(pondLeft, pondTop, pondWidth, POND_HEIGHT))

      // BRIDGE_SLOT_COUNT слотов подряд над прудом, ВПЛОТНУЮ друг к другу
      // (ширина = ровно pondWidth / BRIDGE_SLOT_COUNT, без зазоров) — иначе
      // между двумя уже установленными соседними слотами осталась бы полоска
      // пруда, ничьим слотом не покрытая, и муравей тонул бы, стоя ровно
      // между ними. Последний слот принимает только большую ветку (BigBranch),
      // остальные — любой мелкий материал.
      const slotWidth = pondWidth / BRIDGE_SLOT_COUNT
      const slots: BridgeSlot[] = []
      for (let i = 0; i < BRIDGE_SLOT_COUNT; i++) {
        const slotLeft = pondLeft + slotWidth * i
        const accepts = i === BRIDGE_SLOT_COUNT - 1 ? "bigBranch" : "material"
        const slot = new BridgeSlot(slotLeft, pondTop, slotWidth, POND_HEIGHT, `2:slot:${i}`, accepts)
        this.addEntity(slot)
        slots.push(slot)
      }

      // Чекпоинт на левом берегу, с запасом перед прудом (но правее точки
      // спавна startX + width/2 — см. комментарий у pondLeft выше). Запас
      // (не "pondLeft - 1px") специально больше ширины хитбокса муравья
      // (~45px, см. Ant.applyTextureScale) — иначе муравей, едва ДОЙДЯ до
      // флажка, уже касался бы пруда своим хитбоксом (тот шире, чем видимый
      // силуэт левее container.x) и тонул бы, не успев ничего построить.
      // Respawn-точка по умолчанию (до первого касания) — начало сегмента,
      // где муравей и так появляется после уровня 1.
      this.addEntity(new Checkpoint(pondLeft - 60, startY + this.grassLineY - 6))
      this.lastCheckpointX = startX + 60
      this.lastCheckpointY = startY + this.grassLineY - 6

      // Мелкие материалы (лист/ветка) разбросаны по обоим берегам — с
      // запасом, слотов, которые ими закрываются, BRIDGE_SLOT_COUNT - 1.
      for (let i = 0; i < POND_MATERIAL_COUNT; i++) {
        let materialX = startX + 40 + this.rng() * (width - 80)
        while (isInsidePond(materialX)) {
          materialX = startX + 40 + this.rng() * (width - 80)
        }
        const kind: MaterialKind = this.rng() < 0.5 ? "leaf" : "branch"
        this.addEntity(new Material(materialX, startY + this.grassLineY - 14, `2:material:${i}`, kind))
      }

      // Большая ветка стартует у левого берега и толкается к последнему
      // слоту — см. Ant/BigBranch tick в update().
      const finalSlot = slots[slots.length - 1]
      const bigBranchWidth = MATERIAL_SIZE * 2.2
      const bigBranchTargetX = finalSlot.container.x + finalSlot.width / 2 - bigBranchWidth / 2
      this.addEntity(
        new BigBranch(startX + 90, bigBranchTargetX, startY + this.grassLineY - 10, bigBranchWidth, MATERIAL_SIZE * 1.3),
      )
    } else if (level === 3) {
      // Уровень 3 — единственный водный уровень: муравей уже прошёл
      // метаморфозу в жабу на правом краю уровня 2 (см. update()), и весь
      // сегмент теперь целиком залит водой сверху донизу (Water — не только
      // над травой, как Sky, а во всю высоту), причём заметно выше обычного
      // экрана (см. VERTICAL_WATER_HEIGHT_MULTIPLIER) — жаба спавнится у
      // самого дна (см. handleMetamorphosis/startCoopFrogLevel) и должна
      // всплыть к поверхности, а не просто немного проплыть по одной линии.
      this.addEntity(new Water(startX, startY, width, height))
      // Реальная высота уровня нужна update() (клампы жабы по Y) и следующей
      // метаморфозе (Frog -> Worm, чтобы поставить уровень 4 НИЖЕ водоёма, а
      // не поверх него) — на случай, если height подставился запасным
      // значением (single player), запоминаем именно то, что реально
      // сгенерировали, а не пересчитываем формулу заново в другом месте.
      this.waterLevelHeight = height

      // Кувшинки (чисто "флейвор"-коллекционка) + один спрятанный среди них
      // ключ — только в узкой полосе у самой поверхности (см.
      // LILY_PAD_SURFACE_BAND_HEIGHT): чтобы найти ключ, обязательно нужно
      // всплыть, а не просто поплавать у дна, где спавнится жаба.
      const surfaceTop = startY + 20
      const surfaceBottom = startY + LILY_PAD_SURFACE_BAND_HEIGHT
      const keyIndex = Math.floor(this.rng() * LILY_PAD_COUNT)
      for (let i = 0; i < LILY_PAD_COUNT; i++) {
        const x = startX + 60 + this.rng() * (width - 120)
        const y = surfaceTop + this.rng() * (surfaceBottom - surfaceTop)
        if (i === keyIndex) {
          this.addEntity(new Key(x, y, `${level}:key`))
        } else {
          this.addEntity(new LilyPad(x, y, `${level}:lilypad:${i}`))
        }
      }

      // Подводный проход — у самого дна, по центру; заперт, пока ключ не
      // найден (см. update(), ветка activePlayer instanceof Frog).
      const passageX = startX + width / 2 - SUBMERGED_PASSAGE_WIDTH / 2
      const passageY = startY + height - SUBMERGED_PASSAGE_BOTTOM_MARGIN - SUBMERGED_PASSAGE_HEIGHT
      this.addEntity(
        new SubmergedPassage(passageX, passageY, SUBMERGED_PASSAGE_WIDTH, SUBMERGED_PASSAGE_HEIGHT, `${level}:passage`),
      )
    } else if (level === 4) {
      // Уровень 4 — жаба вернулась червяком через подводный проход (см.
      // handleMetamorphosis) — снова копание, тот же принцип грунта (камень/
      // руда/дирт), что и на уровне 0, только без дверного проёма в потолке:
      // дальше уровней пока нет (см. план), поэтому потолок сплошной бедрок.
      // Врагов/сбор предметов сюда намеренно не добавляем — задача этого
      // уровня только подтвердить, что управление честно переключилось
      // обратно на форму червяка, без лишних новых механик.
      for (let x = startX; x < startX + width + this.cellSize; x += this.cellSize) {
        const isEdgeColumn = x <= startX || x >= startX + width - this.cellSize

        for (let y = startY; y < startY + height; y += this.cellSize) {
          const localY = y - startY
          const cellKey = `${level}:${x}:${y}`

          // Потолок/пол/боковые стены — сплошной непрогрызаемый бедрок,
          // кроме стартовой ямы у самого верха (см. ниже), куда попадает
          // свежий червяк.
          if (localY < this.cellSize || localY >= height - this.cellSize || isEdgeColumn) {
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "bedrock", cellKey))
            continue
          }

          // Стартовая яма у самого верха (то же самое, что и STARTING_PIT у
          // уровня 0, только у потолка, а не у пола — червяк "падает" сюда
          // сверху, из только что закрытого прохода).
          if (
            x > startX + width / 2 - STARTING_PIT_HALF_WIDTH &&
            x < startX + width / 2 + STARTING_PIT_HALF_WIDTH &&
            y < startY + STARTING_PIT_DEPTH + this.cellSize
          ) {
            continue
          }

          const heightFactor = localY / height
          const stoneChance = TERRAIN_STONE_BASE_CHANCE + TERRAIN_STONE_HEIGHT_FACTOR * heightFactor
          const oreChance = TERRAIN_ORE_CHANCE
          const roll = this.rng()
          const type = roll < stoneChance ? "stone" : roll < stoneChance + oreChance ? "ore" : "dirt"
          this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, type, cellKey))
        }
      }
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
    } else if (level === 3) {
      // Уровень 3 (жаба, вода) — сегмент залит целиком, поэтому и граница
      // идёт от самого верха до самого низа, а не только до линии травы.
      // Правый край не закрываем — по X жаба тоже может двигаться в пределах
      // сегмента (см. FROG_EDGE_MARGIN), но выхода за него всё равно нет ни в
      // одну сторону, кроме подводного прохода у дна.
      for (let y = startY; y < startY + height; y += this.cellSize) {
        this.addEntity(new Wall(startX, y, this.cellSize, this.cellSize, "bedrock"))
      }
    }
    // level === 4 сам полностью запечатывает себя (бедрок по всему периметру)
    // в своей собственной ветке генерации выше — отдельная граница тут не нужна.

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

    // this.wallLookup уже видит все стены, добавленные ВЫШЕ в этом же вызове
    // generateNextLevel (indexEntity индексирует их сразу в addEntity) —
    // звёзды/пузырьки/факел лежат буквально закопанными в грунт (это
    // нормально, их и предстоит откопать), но НЕ должны попасть в камень или
    // бедрок: камень убивает при касании, а бедрок вообще не прогрызается —
    // предмет там либо недостижим, либо достаётся только ценой смерти.
    const isInsideImpassableWall = (x: number, y: number): boolean => {
      const type = findWallAt(this.wallLookup, x, y)?.type
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
        if (!isPointBlocked(this.wallLookup, x, y)) break
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
        if (!isPointBlocked(this.wallLookup, spot.x, spot.y)) break
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
    this.indexEntity(entity)
  }

  /** Восстанавливает networking cellKey ("${level}:${x}:${y}") клетки, в
   * которую попадает мировая точка (x, y) — та же сетка (currentLevelXOffset/
   * YOffset, шаг cellSize), которой generateNextLevel помечает сами стены
   * при создании (см. cellKey там), поэтому даёт тот же ключ, под которым
   * стена уже лежит в wallByCellKey. Точка всегда попадает ровно в одну
   * клетку (полуоткрытый интервал, как и у прежнего геометрического
   * findWallAt). Актуально только для levels 0/1 — единственных, где вообще
   * проверяются столкновения со стенами (см. generateNextLevel: level > 1
   * выходит до спавна врагов/стража, которым и нужен этот поиск). */
  private cellKeyFor(x: number, y: number): string {
    const gx = this.currentLevelXOffset + Math.floor((x - this.currentLevelXOffset) / this.cellSize) * this.cellSize
    const gy = this.currentLevelYOffset + Math.floor((y - this.currentLevelYOffset) / this.cellSize) * this.cellSize
    return `${this.levelIndex}:${gx}:${gy}`
  }

  /** Раскладывает только что добавленную сущность по нужным кэшам (см.
   * комментарий у walls/stars/... в начале класса) — вызывается ИЗ
   * addEntity(), сама this.entities не трогает. Симметрична unindexEntity
   * ниже. */
  private indexEntity(entity: Entity): void {
    if (entity instanceof Wall) {
      this.walls.push(entity)
      if (entity.cellKey) {
        this.wallByCellKey.set(entity.cellKey, entity)
        entity.onDirty = (wall) => this.dirtyWalls.add(wall)
      }
      return
    }
    // SpeedBubble ПЕРЕД Bubble — независимые классы (обе extends Entity
    // напрямую), порядок тут не для instanceof-иерархии, а просто чтобы не
    // читать больше одного if.
    if (entity instanceof SpeedBubble) {
      this.speedBubbles.push(entity)
      this.speedBubblesById.set(entity.id, entity)
      return
    }
    if (entity instanceof Bubble) {
      this.bubbles.push(entity)
      this.bubblesById.set(entity.id, entity)
      return
    }
    if (entity instanceof Star) {
      this.stars.push(entity)
      this.starsById.set(entity.id, entity)
      return
    }
    if (entity instanceof RevealSwitch) {
      this.revealSwitches.push(entity)
      this.revealSwitchesById.set(entity.id, entity)
      return
    }
    if (entity instanceof BridgeSlot) {
      this.bridgeSlots.push(entity)
      this.bridgeSlotsById.set(entity.id, entity)
      return
    }
    if (entity instanceof Material) {
      this.materials.push(entity)
      this.materialsById.set(entity.id, entity)
      return
    }
    if (entity instanceof GuardWorm) {
      this.guards.push(entity)
      this.dynamicEntities.push(entity)
      return
    }
    if (entity instanceof EnemyWorm) {
      this.enemies.push(entity)
      this.dynamicEntities.push(entity)
      return
    }
    if (entity instanceof BigBranch) {
      this.bigBranch = entity
      return
    }
    if (entity instanceof Nest) {
      this.nest = entity
      return
    }
    if (entity instanceof Checkpoint) {
      this.checkpoint = entity
      return
    }
    if (entity instanceof Pond) {
      this.pond = entity
      return
    }
    if (entity instanceof SaveButton) {
      this.saveButtons.push(entity)
      return
    }
    // Остальное — статичные декорации без индекса (Sky/Water/
    // LevelDoorMarker, update() у всех пуст) или сами игроки (Worm/Ant/Frog,
    // включая напарника) — им нужен update() каждый кадр (активному —
    // напрямую, напарнику формально тоже, но forEach ниже сам пропускает
    // его через isRemoteEntity).
    if (entity instanceof Worm || entity instanceof Ant || entity instanceof Frog) {
      this.dynamicEntities.push(entity)
    }
  }

  /** Убирает сущность из всех кэшей, в которые её положил indexEntity() —
   * вызывать ПЕРЕД тем, как выкинуть entity из this.entities (см. все места
   * "entities = entities.filter(...)" ниже). Без этого удалённые стены/
   * звёзды и т.п. продолжали бы висеть в кэшах/wallByCellKey вечно — самой
   * очевидной утечкой памяти (PIXI-текстуры не собрались бы GC), даже если
   * из основного массива entities их уже убрали. */
  private unindexEntity(entity: Entity): void {
    if (entity instanceof Wall) {
      removeFromArray(this.walls, entity)
      if (entity.cellKey && this.wallByCellKey.get(entity.cellKey) === entity) this.wallByCellKey.delete(entity.cellKey)
      this.dirtyWalls.delete(entity)
      return
    }
    if (entity instanceof SpeedBubble) {
      removeFromArray(this.speedBubbles, entity)
      this.speedBubblesById.delete(entity.id)
      return
    }
    if (entity instanceof Bubble) {
      removeFromArray(this.bubbles, entity)
      this.bubblesById.delete(entity.id)
      return
    }
    if (entity instanceof Star) {
      removeFromArray(this.stars, entity)
      this.starsById.delete(entity.id)
      return
    }
    if (entity instanceof RevealSwitch) {
      removeFromArray(this.revealSwitches, entity)
      this.revealSwitchesById.delete(entity.id)
      return
    }
    if (entity instanceof BridgeSlot) {
      removeFromArray(this.bridgeSlots, entity)
      this.bridgeSlotsById.delete(entity.id)
      return
    }
    if (entity instanceof Material) {
      removeFromArray(this.materials, entity)
      this.materialsById.delete(entity.id)
      return
    }
    if (entity instanceof GuardWorm) {
      removeFromArray(this.guards, entity)
      removeFromArray(this.dynamicEntities, entity)
      return
    }
    if (entity instanceof EnemyWorm) {
      removeFromArray(this.enemies, entity)
      removeFromArray(this.dynamicEntities, entity)
      return
    }
    if (entity instanceof BigBranch) {
      if (this.bigBranch === entity) this.bigBranch = null
      return
    }
    if (entity instanceof Nest) {
      if (this.nest === entity) this.nest = null
      return
    }
    if (entity instanceof Checkpoint) {
      if (this.checkpoint === entity) this.checkpoint = null
      return
    }
    if (entity instanceof Pond) {
      if (this.pond === entity) this.pond = null
      return
    }
    if (entity instanceof SaveButton) {
      removeFromArray(this.saveButtons, entity)
      return
    }
    removeFromArray(this.dynamicEntities, entity)
  }

  /** Полный сброс всех кэшей — рестарт уровня/комнаты (см. restartLevel) и
   * широковещательный переход уровня (см. applyLevelAdvanced), где старое
   * содержимое this.entities выбрасывается целиком (или почти целиком) одним
   * махом, а не поштучно через unindexEntity. */
  private clearEntityIndices(): void {
    this.walls = []
    this.wallByCellKey.clear()
    this.dirtyWalls.clear()
    this.stars = []
    this.starsById.clear()
    this.bubbles = []
    this.bubblesById.clear()
    this.speedBubbles = []
    this.speedBubblesById.clear()
    this.revealSwitches = []
    this.revealSwitchesById.clear()
    this.guards = []
    this.enemies = []
    this.materials = []
    this.materialsById.clear()
    this.bridgeSlots = []
    this.bridgeSlotsById.clear()
    this.bigBranch = null
    this.nest = null
    this.checkpoint = null
    this.pond = null
    this.saveButtons = []
    this.dynamicEntities = []
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

    // Индикатор переносимого материала — виден только на уровне 3 (пруд/
    // мост) и только пока муравей что-то несёт в щелепах (см. updateHud).
    this.leavesText = new Text({
      text: "🍃",
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
      // Виден только на уровне 3 (пруд/мост) и только пока муравей реально
      // что-то несёт — вне этого уровня переносить нечего.
      this.leavesText.visible = this.levelIndex === 2 && this.carriedMaterialKind !== null
      this.leavesText.text = this.carriedMaterialKind === "leaf" ? "🍃 в щелепах" : this.carriedMaterialKind === "branch" ? "🌿 в щелепах" : ""
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
      this.fogTextureRadius = this.lightRadius

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

  /** Перестраивает текстуру тумана под новый lightRadius — дорогая операция
   * (рисует и грузит в GPU текстуру в несколько раз больше экрана), поэтому
   * вызывается только на структурные сбросы (старт/рестарт уровня, догоняющий
   * снапшот при входе), а не на каждый подобранный пузырёк — см. updateLightRadius. */
  private rebuildFogTexture(): void {
    if (!this.fogSprite) return

    const oldTexture = this.fogSprite.texture
    this.fogSprite.texture = this.buildFogTexture()
    // oldTexture может оказаться уже null, если fogSprite успел быть
    // уничтожен целиком (Scene.destroy() -> container.destroy({children:true}))
    // асинхронной цепочкой, продолжившей выполняться уже после этого (см.
    // GameScene.destroyed) — сам this.fogSprite при этом остаётся тем же
    // JS-объектом, просто с обнулёнными внутренностями.
    oldTexture?.destroy(true)

    // Новая текстура один в один соответствует текущему lightRadius —
    // масштаб сбрасываем к 1, а fogTextureRadius запоминаем как точку отсчёта
    // для дальнейшего масштабирования (см. updateFog).
    this.fogTextureRadius = this.lightRadius
    this.fogSprite.scale.set(1)
  }

  /**
   * Двигает "дырку" тумана к текущей экранной позиции игрока, растягивает её
   * под текущий (уже сглаженный updateLightRadius) lightRadius и включает
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

      // Радиус "дырки" запечён в текстуру под fogTextureRadius — рост от
      // пузырька (targetLightRadius, сглаженный в lightRadius) рисуем просто
      // масштабом спрайта, без перестройки текстуры на каждый кадр анимации.
      if (this.fogTextureRadius > 0) {
        this.fogSprite.scale.set(this.lightRadius / this.fogTextureRadius)
      }
    }
  }

  /** Плавно "доводит" lightRadius до targetLightRadius после подбора пузырька
   * света — экспоненциальное сглаживание, тот же приём, что и у стрелки
   * партнёра/камеры (см. PARTNER_ARROW_SMOOTHING/WORM_CAMERA_FOLLOW_LERP). Сам
   * пузырёк только двигает targetLightRadius, здесь это превращается в
   * плавный рост видимого круга света вместо мгновенного скачка. */
  private updateLightRadius(deltaTime: number): void {
    if (this.lightRadius === this.targetLightRadius) return

    const smoothing = Math.min(1, this.lightRadiusSmoothing * deltaTime)
    this.lightRadius += (this.targetLightRadius - this.lightRadius) * smoothing

    if (Math.abs(this.targetLightRadius - this.lightRadius) < 0.5) {
      this.lightRadius = this.targetLightRadius
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

        if (this.metaTimer >= TRANSFORM_DURATION && !this.pendingWaterSegment) {
          if (this.activePlayer instanceof Worm) {
            this.worldContainer.removeChild(this.activePlayer.container)
            this.entities = this.entities.filter((e) => e !== this.activePlayer)
            this.unindexEntity(this.activePlayer)

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
            this.metaState = MetaState.ZOOM_OUT
          } else if (this.activePlayer instanceof Ant) {
            // Ant -> Frog: муравей у правого края уровня 2 (лужи/листья)
            // превращается в жабу — и заодно уровень тут же переходит на
            // следующий (водный) сегмент, тем же приёмом, что и обычный
            // переход между сегментами муравья (levelIndex++, X-смещение на
            // ширину экрана, чистка сущностей позади), только сопровождается
            // самим превращением, а не происходит мгновенно.
            //
            // В co-op сперва нужно узнать у сервера канонический seed/размер
            // ПЕРВОГО водного сегмента (см. prepareWaterSegment) — держим
            // муравья на экране ещё несколько кадров (pendingWaterSegment
            // блокирует повторный вход сюда, TRANSFORM-анимация просто
            // продолжает мигать — безвредно, alpha/scale периодические), пока
            // не придёт ответ. В single player prepareWaterSegment()
            // резолвится немедленно (сети нет).
            this.pendingWaterSegment = true
            const targetLevel = this.levelIndex + 1

            this.prepareWaterSegment(targetLevel).then(() => {
              this.pendingWaterSegment = false
              if (this.destroyed) return

              this.worldContainer.removeChild(this.activePlayer.container)
              this.entities = this.entities.filter((e) => e !== this.activePlayer)
              this.unindexEntity(this.activePlayer)

              this.levelIndex = targetLevel
              this.currentLevelXOffset += window.innerWidth

              const safeXBound = this.currentLevelXOffset - window.innerWidth * 2
              this.entities = this.entities.filter((entity) => {
                if (entity.container.x < safeXBound) {
                  this.worldContainer.removeChild(entity.container)
                  this.unindexEntity(entity)
                  return false
                }
                return true
              })

              this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)
              this.applyWaterLevelCatchUp()

              // Жаба рождается у самого дна (у подводного прохода) — уровень
              // 3 заметно выше обычного экрана (см. waterLevelHeight, уже
              // заполненный generateNextLevel выше), и всплыть к поверхности
              // (за кувшинками/ключом) предстоит именно ей самой, а не начать
              // сразу оттуда.
              const frogY = this.currentLevelYOffset + this.waterLevelHeight - SUBMERGED_PASSAGE_HEIGHT - SUBMERGED_PASSAGE_BOTTOM_MARGIN - 60
              const frogX = this.currentLevelXOffset + window.innerWidth / 2
              const frog = new Frog(this.input, frogX, frogY)
              this.activePlayer = frog

              this.addEntity(frog)
              this.worldContainer.addChild(frog.container)

              console.log("Метаморфоз завершён! Рождена Жаба.")
              this.metaState = MetaState.ZOOM_OUT
            })
          } else if (this.activePlayer instanceof Frog && !this.pendingWormInit) {
            // Frog -> Worm: жаба у открытого (ключ найден) подводного прохода
            // в самом низу уровня 3 превращается обратно в червя — уровень 4
            // (снова копание) генерируется тут же: в co-op — из
            // pendingLevel4State, уже присланного сервером вместе с
            // waterPassageEntered (см. триггер этого перехода в update()),
            // чтобы оба игрока получили один и тот же seed/размер; в single
            // player — просто локально, тем же способом, что и старт уровня 0.
            //
            // pendingWormInit держит TRANSFORM тут же (без повторного захода в
            // эту ветку каждый кадр) до тех пор, пока не загрузится спрайт
            // нового червяка (Worm.init() асинхронный, в отличие от Ant/Frog) —
            // тот же принцип, что и pendingWaterSegment выше.
            this.pendingWormInit = true

            const level4State = this.pendingLevel4State
            this.pendingLevel4State = null

            if (level4State) {
              this.prepareRoomLevel(level4State, this.network.getEpoch())
            } else {
              this.rng = Math.random
              this.roomLevelWidth = this.digLevelWidth()
              this.roomLevelHeight = this.digLevelHeight()
              this.levelIndex = 4
            }

            // Новый, заведомо свободный от всего остального (диг-фазы,
            // поверхности, самого водоёма) блок координат — ниже уровня 3 по
            // Y (тот уже целиком известен, см. waterLevelHeight), дальше по X.
            const nextYOffset = this.currentLevelYOffset + this.waterLevelHeight + this.digLevelHeight()
            const nextXOffset = this.currentLevelXOffset + window.innerWidth

            const worm = new Worm(this.input)
            worm.init().then(() => {
              this.pendingWormInit = false
              if (this.destroyed) return

              this.worldContainer.removeChild(this.activePlayer.container)
              this.entities = this.entities.filter((e) => e !== this.activePlayer)

              this.currentLevelYOffset = nextYOffset
              this.currentLevelXOffset = nextXOffset

              const safeXBound = this.currentLevelXOffset - window.innerWidth * 2
              this.entities = this.entities.filter((entity) => {
                if (entity.container.x < safeXBound) {
                  this.worldContainer.removeChild(entity.container)
                  return false
                }
                return true
              })

              this.generateNextLevel(this.currentLevelXOffset, this.currentLevelYOffset, this.levelIndex)

              worm.container.x = this.currentLevelXOffset + this.roomLevelWidth / 2
              worm.container.y = this.currentLevelYOffset + 60
              this.activePlayer = worm

              this.addEntity(worm)
              this.worldContainer.addChild(worm.container)

              console.log("Метаморфоз завершён! Жаба снова стала червяком.")
              this.metaState = MetaState.ZOOM_OUT
            })
          }
        }
        break

      case MetaState.ZOOM_OUT: {
        // Название состояния осталось от старой версии (когда камера
        // действительно зумилась обратно до 1x) — теперь же она, наоборот,
        // доводится ДО целевого зума новой формы (antFocusZoomScale у
        // муравья, frogFocusZoomScale у жабы, wormFocusZoomScale у
        // вернувшегося червяка — все больше пикового зума самого
        // превращения) и остаётся там: игрок всегда в фокусе камеры, она не
        // возвращается к обычному виду всего экрана.
        const targetZoomScale = this.activePlayer instanceof Frog
          ? this.frogFocusZoomScale
          : this.activePlayer instanceof Worm
            ? this.wormFocusZoomScale
            : this.antFocusZoomScale

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

  /** Тоже вызывается при смерти (см. update()), а теперь ещё и явно из
   * меню паузы ("Начать уровень заново" — см. PauseMenu/Engine.restartLevel) —
   * поэтому public, а не только internal. */
  public restartLevel(): void {
    this.worldContainer.removeChildren()
    this.entities = []
    this.clearEntityIndices()
    // Контейнеры напарника уже уничтожены строкой выше (removeChildren) —
    // забываем и сами инстансы, иначе следующий syncNetwork() попытается
    // двигать сущности, которых больше нет в мире, вместо того чтобы
    // создать их заново.
    this.remoteEntities.clear()
    this.deathTimer = 0
    // Ручной рестарт из меню паузы не обязан снимать паузу сам по себе —
    // это решает вызывающий код (PauseMenu закрывает меню и снимает паузу
    // одним действием), но на всякий случай не оставляем локальное
    // управление заблокированным для новой сцены, если вызвали не оттуда.
    this.setPaused(false)
    this.onCreate()
  }

  /** См. PauseMenu — переопределяет пустую реализацию по умолчанию из Scene. */
  public override setPaused(paused: boolean): void {
    this.paused = paused
    this.input.setEnabled(!paused)
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
      const form: PlayerForm = this.activePlayer instanceof Ant ? "ant" : this.activePlayer instanceof Frog ? "frog" : "worm"
      this.network.reportLocalPose(this.activePlayer.container.x, this.activePlayer.container.y, form)
    }

    const remoteStates = this.network.getRemotePlayerStates()
    const seenPlayerIds = new Set<string>()

    for (const state of remoteStates) {
      seenPlayerIds.add(state.playerId)
      this.upsertRemoteEntity(state, deltaTime)
    }

    for (const [playerId, remote] of this.remoteEntities) {
      if (seenPlayerIds.has(playerId)) continue

      this.worldContainer.removeChild(remote.entity.container)
      this.entities = this.entities.filter((e) => e !== remote.entity)
      this.unindexEntity(remote.entity)
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

  /** Все "игроки", реально видимые в этом кадре — свой активный + напарники
   * (в co-op на общем уровне у нас есть их визуальные прокси-сущности,
   * синхронизируемые в syncNetwork; этого достаточно для проверки
   * столкновений с врагами/стражем на стороне хоста, даже если у хоста нет
   * прямого доступа к настоящему инстансу игрока напарника). Мёртвые
   * (isDead) исключаются — как и раньше для одиночного activePlayer. */
  private getAllPlayerEntities(): (Worm | Ant | Frog)[] {
    const result: (Worm | Ant | Frog)[] = []
    if (this.activePlayer && this.dynamicEntities.includes(this.activePlayer) && !this.activePlayer.isDead) {
      result.push(this.activePlayer)
    }
    for (const remote of this.remoteEntities.values()) {
      if (!remote.entity.isDead) result.push(remote.entity)
    }
    return result
  }

  /** То же самое, что и getAllPlayerEntities(), но в формате, который
   * понимает GuardWorm.tick() — только позиция + стабильный id (нужен ему для
   * гистерезиса переключения цели между кадрами, см. GuardWorm.currentTargetId).
   * "local" — id нашего собственного игрока, playerId напарника — ключ той
   * же remoteEntities Map, что использует upsertRemoteEntity. */
  private getGuardTargets(): GuardTarget[] {
    const targets: GuardTarget[] = []
    if (this.activePlayer && this.dynamicEntities.includes(this.activePlayer) && !this.activePlayer.isDead) {
      targets.push({ id: "local", x: this.activePlayer.container.x, y: this.activePlayer.container.y })
    }
    for (const [playerId, remote] of this.remoteEntities) {
      if (!remote.entity.isDead) targets.push({ id: playerId, x: remote.entity.container.x, y: remote.entity.container.y })
    }
    return targets
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
  private upsertRemoteEntity(state: PlayerState, deltaTime: number): void {
    let remote = this.remoteEntities.get(state.playerId)

    if (!remote) {
      // Уже в нужной форме сразу (а не всегда Worm с последующей мгновенной
      // пересоздачей ниже) — важно для позднего присоединения: если
      // напарник к этому моменту уже, скажем, жаба, самый первый снапшот о
      // нём тоже должен создать именно Frog.
      const entity = this.createRemotePlayerEntity(state.form, state.x, state.y)
      entity.applyRemoteLook(this.getRemoteRole(state.playerId))

      remote = { entity, form: state.form }
      this.remoteEntities.set(state.playerId, remote)
      this.addEntity(entity)
    }

    if (remote.form !== state.form) {
      // Напарник прошёл метаморфозу у себя — пересоздаём ТЕМ ЖЕ классом, что
      // и локальный игрок (Worm -> Ant -> Frog, см. createRemotePlayerEntity),
      // без кат-сцены с зумом: камера в этой сцене одна и следит только за
      // нашим собственным игроком.
      this.worldContainer.removeChild(remote.entity.container)
      this.entities = this.entities.filter((e) => e !== remote!.entity)
      this.unindexEntity(remote.entity)

      const nextEntity = this.createRemotePlayerEntity(state.form, state.x, state.y)
      nextEntity.applyRemoteLook(this.getRemoteRole(state.playerId))
      remote = { entity: nextEntity, form: state.form }
      this.remoteEntities.set(state.playerId, remote)
      this.addEntity(nextEntity)
    }

    if (remote.entity instanceof Ant) {
      // Муравей ходит только по одной линии травы — Y не шарится (см.
      // Ant.setRemotePosition).
      remote.entity.setRemotePosition(state.x, deltaTime)
    } else {
      // Worm/Frog двигаются по обеим осям.
      remote.entity.setRemotePosition(state.x, state.y, deltaTime)
    }
  }

  /** Создаёт сущность напарника нужного класса по его форме — единственное
   * место, решающее "какой класс соответствует какой PlayerForm" (используется
   * и при первом появлении неизвестного напарника, и при пересоздании после
   * его метаморфозы, см. upsertRemoteEntity выше). */
  private createRemotePlayerEntity(form: PlayerForm, x: number, y: number): Worm | Ant | Frog {
    if (form === "ant") return new Ant(this.dummyInput, x, y)
    if (form === "frog") return new Frog(this.dummyInput, x, y)

    const worm = new Worm(this.dummyInput)
    worm.container.x = x
    worm.container.y = y
    worm.init()
    return worm
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
    this.updateLightRadius(deltaTime)
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

      if (this.levelIndex <= 2) {
        this.processSharedLevelEvents()
      }
    }

    if (this.metaState !== MetaState.NONE) {
      this.handleMetamorphosis(deltaTime)
      return
    }

    // Пауза (см. setPaused/PauseMenu) — блокирует ТОЛЬКО локальную часть кадра
    // ниже (смерть/рестарт по таймеру, движение, переходы между уровнями,
    // подбор предметов, камера) — то, что относится исключительно к
    // локальному игроку. syncNetwork/обработка широковещательных событий/ИИ
    // врагов и стража (тикаются отдельно, ниже по этому же методу, вне
    // блоков this.activePlayer) продолжают идти как обычно, иначе в co-op
    // пауза одного игрока замораживала бы игру партнёра тоже.
    if (!this.paused && this.activePlayer && this.activePlayer.isDead) {
      this.deathTimer += deltaTime
      if (this.deathTimer >= DEATH_RESTART_DELAY) {
        if (this.levelIndex === 2) {
          // Пруд/мост: смерть (утопление) — ЛИЧНАЯ, не рестартит ни уровень,
          // ни (в co-op) комнату партнёра — респавн на чекпоинте, Pond/
          // BridgeSlot/Material/BigBranch остаются как были (см. план —
          // "не перезапускай весь рівень через смерть одного гравця").
          this.respawnAntAtCheckpoint()
        } else if (this.network.getSnapshot().mode === "coop" && this.levelIndex <= 1) {
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

    if (!this.paused && this.activePlayer) {
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
              this.unindexEntity(entity)
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
      // поверхности с прудом, симметрично тому, как вертикальные уровни
      // открываются вверх при достижении верхнего края. В co-op пруд/мост —
      // общее состояние комнаты (см. RoomLevelState.materialCarriers/
      // bridgeSlots/bigBranch), поэтому сам переход идёт через тот же
      // requestAdvanceLevel, что и 0->1 (см. applyLevelAdvanced), а не
      // мгновенно локально.
      if (this.activePlayer instanceof Ant && this.levelIndex === 1) {
        const localPlayerX = this.activePlayer.container.x - this.currentLevelXOffset

        if (localPlayerX >= window.innerWidth - 40) {
          if (this.network.getSnapshot().mode === "coop") {
            // Держим игрока у края, пока не придёт общий переход — тот же
            // приём, что и у перехода 0->1 (см. выше в update()).
            this.activePlayer.container.x = this.currentLevelXOffset + window.innerWidth - 40
            if (!this.pendingAdvanceLevel) {
              this.pendingAdvanceLevel = true
              this.network.requestAdvanceLevel(1, 2, window.innerWidth, window.innerHeight)
            }
            return
          }

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
              this.unindexEntity(entity)
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

      // Уровень 3 (единственный водный уровень) — кувшинки/ключ/подводный
      // проход (см. GameScene.generateNextLevel, level === 3). В co-op ключ и
      // кувшинки — общие для комнаты (тот же принцип "первый забрал —
      // навсегда для всех", что и у пузырьков/факела, см.
      // WaterSegmentState.collectedItemIds): не гасим их локально сами, ждём
      // подтверждения от сервера (waterItemCollected), иначе одновременный
      // подбор двумя игроками задвоил бы эффект/сбил анти-даблпик.
      if (this.activePlayer instanceof Frog && this.levelIndex === 3) {
        const isCoop = this.network.getSnapshot().mode === "coop"

        if (isCoop) {
          for (const update of this.network.drainWaterItemCollected()) {
            if (update.level !== this.levelIndex) continue
            const item = this.entities.find(
              (e): e is LilyPad | Key => (e instanceof LilyPad || e instanceof Key) && e.id === update.itemId,
            )
            if (item) item.container.visible = false
            if (update.keyFound) this.keyFound = true
          }

          const advanced = this.network.drainWaterPassageEntered()
          if (advanced) {
            this.pendingLevel4State = advanced.levelState
            this.metaState = MetaState.ZOOM_IN
            this.metaTimer = 0
            return
          }
        } else {
          const lilyPads = this.entities.filter((e): e is LilyPad => e instanceof LilyPad)
          for (const pad of lilyPads) {
            if (pad.container.visible && this.activePlayer.isColliding(pad)) {
              pad.container.visible = false
            }
          }

          const keys = this.entities.filter((e): e is Key => e instanceof Key)
          for (const key of keys) {
            if (key.container.visible && this.activePlayer.isColliding(key)) {
              key.container.visible = false
              this.keyFound = true
            }
          }
        }

        if (isCoop) {
          const lilyPads = this.entities.filter((e): e is LilyPad => e instanceof LilyPad)
          for (const pad of lilyPads) {
            if (pad.container.visible && this.activePlayer.isColliding(pad)) {
              this.network.requestWaterItemPickup(this.levelIndex, pad.id, false)
            }
          }

          const keys = this.entities.filter((e): e is Key => e instanceof Key)
          for (const key of keys) {
            if (key.container.visible && this.activePlayer.isColliding(key)) {
              this.network.requestWaterItemPickup(this.levelIndex, key.id, true)
            }
          }
        }

        const passages = this.entities.filter((e): e is SubmergedPassage => e instanceof SubmergedPassage)
        for (const passage of passages) {
          if (this.keyFound) passage.open()

          if (this.keyFound && passage.isUnlocked && this.activePlayer.isColliding(passage)) {
            if (isCoop) {
              if (!this.pendingWaterPassageEnter) {
                this.pendingWaterPassageEnter = true
                this.network.requestWaterPassageEnter(this.levelIndex, this.digLevelWidth(), this.digLevelHeight())
              }
            } else {
              this.metaState = MetaState.ZOOM_IN
              this.metaTimer = 0
              return
            }
          }
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

    const stars = this.stars

    let prevPlayerX = 0
    let prevPlayerY = 0

    const isCoopShared = this.network.getSnapshot().mode === "coop" && this.levelIndex <= 1

    // prevPlayerX/Y нужны и ниже (страж отталкивает игрока назад при
    // столкновении) ДАЖЕ на паузе — держим их актуальными всегда, а не
    // только внутри paused-гейта, иначе, если что-то заденет
    // приостановленного игрока, его откатило бы в (0, 0) вместо текущей
    // (просто неподвижной) позиции. dynamicEntities вместо entities — тот же
    // список "жив ли ещё этот конкретный игрок", только маленький (враги/
    // страж/игроки), а не все стены уровня (см. indexEntity/unindexEntity).
    if (this.activePlayer && this.dynamicEntities.includes(this.activePlayer)) {
      prevPlayerX = this.activePlayer.container.x
      prevPlayerY = this.activePlayer.container.y
    }

    if (!this.paused && this.activePlayer && this.dynamicEntities.includes(this.activePlayer)) {
      this.activePlayer.update(deltaTime, this.wallLookup, stars)

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

        // Уровень 3 (индекс 2) — пруд/мост: чекпоинт, утопление, подбор и
        // установка материала, толкание большой ветки. Пока муравей
        // "борсается" после drown() (isFlailing) — никаких новых
        // взаимодействий, только ждём, чем кончится (см. Ant.drown()).
        if (!this.activePlayer.isFlailing) {
          const ant = this.activePlayer

          const checkpoint = this.checkpoint
          if (checkpoint && ant.isColliding(checkpoint)) {
            this.lastCheckpointX = ant.container.x
            this.lastCheckpointY = ant.container.y
          }

          // Подбор мелкого материала (лист/ветка) — только если ещё ничего не несём.
          if (!this.carriedMaterialKind) {
            for (const material of this.materials) {
              if (material.container.visible && ant.isColliding(material)) {
                this.tryGrabMaterial(material)
                break
              }
            }
          }

          // Установка в подходящий (ещё пустой) слот моста — рядом и материал
          // в щелепах. Нарочно ДО проверки утопления ниже: муравей, только
          // что дошедший до первого незаполненного слота с материалом,
          // должен успеть установить его и тем самым спастись, а не тонуть
          // на пороге собственной постройки (см. POND_DROWN_GRACE — в co-op
          // установка ещё и не применяется мгновенно, идёт через сервер).
          if (this.carriedMaterialId && this.carriedMaterialKind) {
            const carriedMaterial = this.materialsById.get(this.carriedMaterialId)
            const openSlot = this.bridgeSlots.find((slot) => !slot.isInstalled && slot.accepts === "material" && ant.isColliding(slot))

            if (carriedMaterial && openSlot) {
              this.tryInstallMaterial(carriedMaterial, openSlot)
            }
          }

          let justDrowned = false
          const pond = this.pond
          if (pond && ant.isColliding(pond)) {
            // isColliding (не одна точка container.x) — тем же способом, что
            // и столкновение с самим прудом выше: у Entity/Ant рамка
            // столкновений — это весь AABB (container.x..+width), а не одна
            // точка, так что "стоит ли муравей на мосту" обязана мериться
            // тем же способом, иначе муравей мог тонуть, едва коснувшись
            // края пруда хитбоксом, ещё визуально стоя на предыдущем
            // (уже наведённом) слоте или даже на берегу перед первым слотом.
            const isOnBridge = this.bridgeSlots.some((slot) => slot.isInstalled && ant.isColliding(slot))

            if (isOnBridge) {
              this.pondUnsafeTimer = 0
            } else {
              // Не мгновенно на первом же кадре касания (см. POND_DROWN_GRACE) —
              // даёт установке слота выше (особенно в co-op, где она идёт
              // через сервер и применяется не в этом же кадре) шанс сработать
              // раньше, чем муравей будет считаться утонувшим.
              this.pondUnsafeTimer += deltaTime
              if (this.pondUnsafeTimer >= POND_DROWN_GRACE) {
                this.drownActivePlayer(ant)
                justDrowned = true
              }
            }
          } else {
            this.pondUnsafeTimer = 0
          }

          if (!justDrowned) {
            // Большая ветка — толкают 1 (медленно, в одиночной игре — за
            // несколько заходов) или 2 муравья (нормальная скорость) разом.
            // Считает только тот, кто её реально симулирует (хост/single
            // player), см. BigBranch — гость лишь отрисовывает setRemoteState.
            const bigBranch = this.bigBranch
            const simulatesBigBranch = this.network.getSnapshot().mode !== "coop" || this.network.isHost()

            if (bigBranch && !bigBranch.installed && simulatesBigBranch) {
              const carrierIds: string[] = []
              const localId = this.network.getSnapshot().localPlayerId

              if (!this.carriedMaterialKind && ant.isColliding(bigBranch) && localId) {
                carrierIds.push(localId)
              }
              for (const [playerId, remote] of this.remoteEntities) {
                if (remote.entity instanceof Ant && !remote.entity.isDead && remote.entity.isColliding(bigBranch)) {
                  carrierIds.push(playerId)
                }
              }

              bigBranch.tick(deltaTime, carrierIds.length)

              if (bigBranch.progress >= 1) {
                bigBranch.markInstalled()
                const finalSlot = this.bridgeSlots.find((slot) => slot.accepts === "bigBranch")
                if (finalSlot && !finalSlot.isInstalled) finalSlot.install("bigBranch", "bigBranch")
              }

              this.network.sendBigBranchState(this.levelIndex, bigBranch.progress, carrierIds)
            }
          }
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
        for (const button of this.saveButtons) {
          if (!button.isPressed && this.activePlayer.isColliding(button)) {
            button.press()
            this.saveLevelProgress(this.levelIndex)
            console.log(`Прогресс сохранён! Уровень ${this.levelIndex}.`)
          }
        }
      }

      if (this.activePlayer instanceof Frog) {
        // Жаба плавает свободно в толще воды — в отличие от муравья, границы
        // сегмента считаем по ОБЕИМ осям (X и Y), не только по X. По Y — не
        // window.innerHeight (уровень 3 заметно выше обычного экрана), а
        // реальная высота уровня (см. waterLevelHeight, заполняется
        // generateNextLevel) с тем же запасным множителем, что и там.
        const levelHeight = this.waterLevelHeight || window.innerHeight * VERTICAL_WATER_HEIGHT_MULTIPLIER
        const minX = this.currentLevelXOffset + FROG_EDGE_MARGIN
        const maxX = this.currentLevelXOffset + window.innerWidth - FROG_EDGE_MARGIN
        const minY = this.currentLevelYOffset + FROG_EDGE_MARGIN
        const maxY = this.currentLevelYOffset + levelHeight - FROG_EDGE_MARGIN
        this.activePlayer.container.x = Math.min(Math.max(this.activePlayer.container.x, minX), maxX)
        this.activePlayer.container.y = Math.min(Math.max(this.activePlayer.container.y, minY), maxY)

        // Камера держит фокус на жабе постоянно, как и на муравье — только
        // теперь ещё и по вертикали, раз жаба плавает по обеим осям.
        this.worldContainer.pivot.set(this.activePlayer.container.x, this.activePlayer.container.y)
        this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
      }

      // Звёзды — единая точка подбора tryPickupStar() (см. выше), сама
      // решает solo/co-op и не даёт слать повторный запрос, пока предыдущий
      // ещё не подтверждён (см. pendingStarPickups). В отличие от пузырьков/
      // факела ниже (обычное AABB-пересечение по ТЕКУЩЕЙ позиции) тут
      // проверяем весь пройденный за кадр отрезок (prevPlayerX/Y -> текущая
      // позиция), а не только конечную точку — звезда маленькая (STAR_SIZE),
      // и при просадке кадра (лаг-спайк/большой deltaTime, тот же
      // прыгающий боост скорости) игрок вполне может целиком перепрыгнуть
      // её хитбокс за один шаг, ни разу не пересекшись с ним в конечной
      // позиции — тогда её никак не подобрать.
      for (const star of stars) {
        if (star.container.visible && this.isPlayerPathNearStar(prevPlayerX, prevPlayerY, star)) {
          this.tryPickupStar(star)
        }
      }

      // Пузырьки света не встроены в логику Worm.update — подбираем их прямо
      // тут через обычное AABB-пересечение и сразу расширяем радиус тумана.
      for (const bubble of this.bubbles) {
        if (bubble.container.visible && this.activePlayer.isColliding(bubble)) {
          if (isCoopShared) {
            // Не гасим локально и не трогаем lightRadius тут же — ждём
            // подтверждения от сервера (boostUpdate), иначе при одновременном
            // касании двумя игроками бонус применился бы дважды.
            this.network.requestBoostActivate(this.levelIndex, bubble.id, "light")
          } else {
            bubble.container.visible = false
            // Как и в co-op-ветке выше — двигаем только цель, растёт плавно
            // в updateLightRadius, без хитча от синхронной перестройки тумана.
            this.targetLightRadius += this.lightRadiusPerBubble
            console.log("Пузырёк света собран! Радиус видимости увеличен.")
          }
        }
      }

      // Пузырьки скорости — тот же принцип, только временный буст вместо
      // постоянной добавки к радиусу (см. GameConfig.SPEED_BOOST_DURATION).
      for (const speedBubble of this.speedBubbles) {
        if (speedBubble.container.visible && this.activePlayer.isColliding(speedBubble)) {
          if (isCoopShared) {
            this.network.requestBoostActivate(this.levelIndex, speedBubble.id, "speed")
          } else {
            speedBubble.container.visible = false
            this.speedBoostTimer = SPEED_BOOST_DURATION
            console.log(`Пузырёк скорости собран! Скорость временно увеличена в ${SPEED_BOOST_MULTIPLIER}x.`)
          }
        }
      }

      // Факел-выключатель — так же, отдельным AABB-пересечением: подобрал —
      // на минуту туман войны полностью выключается.
      for (const revealSwitch of this.revealSwitches) {
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
    const nestForFilter = this.nest
    const stealableStars = nestForFilter
      ? stars.filter((star) => Math.hypot(star.container.x - nestForFilter.container.x, star.container.y - nestForFilter.container.y) > NEST_STORAGE_RADIUS)
      : stars

    // dynamicEntities — уже НЕ весь this.entities, а только то, что вообще
    // может иметь непустой update() (враги/страж/игроки, см. indexEntity) —
    // статичные стены/звёзды/пузырьки/слоты и т.п. сюда даже не попадают, их
    // update() всё равно всегда пуст (см. соответствующие классы).
    for (const entity of this.dynamicEntities) {
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
        entity.update(deltaTime, this.wallLookup, stealableStars)
      }
    }

    // Страж реагирует на ЛЮБОГО игрока комнаты (см. GuardWorm.tick — ближайший
    // в зоне агрессии, с гистерезисом переключения цели), вражеских воров ему
    // вообще не передаём, поэтому пока он занят погоней в одном тоннеле, вор
    // спокойно проскакивает мимо по другому пути. Столкновение с игроком
    // смертельно: откатываем игрока на позицию до этого кадра (как будто
    // упёрся в стену) и сразу убиваем — как от камня, дальше сработает
    // обычный рестарт уровня по deathTimer. Это столкновение проверяем только
    // для НАШЕГО собственного игрока — каждый клиент сам себе авторитет по
    // смерти своего активного игрока (как и от камня/руки стража повсюду
    // ниже); напарник ровно так же убьёт себя сам на своём клиенте.
    const guards = this.guards
    const playerForGuard = this.activePlayer && this.dynamicEntities.includes(this.activePlayer) ? this.activePlayer : undefined
    const guardTargets = this.getGuardTargets()

    for (const guard of guards) {
      guard.tick(deltaTime, this.wallLookup, guardTargets)
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
    const enemies = this.enemies
    const nest = nestForFilter

    // Co-op: только хост комнаты реально симулирует кражу/доставку звёзд —
    // канонические враги ОДНИ на комнату (см. EnemyWorm.setRemoteState).
    // Гость получает тот же результат визуально через applyEnemyNetStates()
    // (см. processSharedLevelEvents), а не пересчитывает эту логику сам.
    const isHostSimulating = !isCoopShared || this.network.isHost()

    if (isHostSimulating) {
      // Валидное столкновение с вором — это столкновение ЛЮБОГО игрока
      // комнаты, не только собственного activePlayer хоста: у хоста нет
      // прямого доступа к настоящему инстансу игрока-напарника, но есть его
      // синхронизированная прокси-сущность (см. getAllPlayerEntities), и её
      // позиции для проверки столкновения достаточно.
      const players = this.getAllPlayerEntities()

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

        const collidingPlayer = enemy.carriedStar ? players.find((player) => player.isColliding(enemy)) : undefined
        if (enemy.carriedStar && collidingPlayer) {
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

    // Стены, ударенные в этом кадре (см. Wall.onDirty/dirtyWalls) —
    // вычерпываем и сбрасываем justHit ВСЕГДА (не только в co-op), иначе в
    // single player это множество только бы росло весь забег и никогда не
    // освобождало бы ссылки на давно прогрызенные/оставленные позади стены.
    // Сканируем ПОСЛЕ всех апдейтов этого кадра (игрок уже прогрыз своё выше,
    // хост-враги — в цикле по dynamicEntities чуть раньше в этом же кадре),
    // чтобы не упустить ни один удар.
    if (this.dirtyWalls.size > 0) {
      for (const wall of this.dirtyWalls) {
        wall.justHit = false
        if (isCoopShared && wall.cellKey) {
          const hits = wall.maxHitPoints - wall.hitPoints
          this.network.reportWallHit(this.levelIndex, wall.cellKey, hits, wall.hitPoints <= 0)
        }
      }
      this.dirtyWalls.clear()
    }

    if (isCoopShared && this.network.isHost()) {
      // Только хост реально шлёт это (см. GameNetworkStore.sendEnemyState) —
      // сервер лишь хранит последнее известное состояние и ретранслирует
      // партнёру, сама AI-симуляция остаётся полностью локальной у хоста.
      const netStates: EnemyNetState[] = [
        ...guards.map((g) => g.toNetState()),
        ...enemies.map((e) => e.toNetState(e.carriedStar?.id ?? null)),
      ]
      this.network.sendEnemyState(this.levelIndex, netStates)
    }
  }
}

/** Удаляет первое вхождение item из array, если оно там есть — вынесено из
 * класса, т.к. используется только внутри unindexEntity (см. выше) для
 * нескольких разнотипных кэш-массивов подряд. */
function removeFromArray<T>(array: T[], item: T): void {
  const index = array.indexOf(item)
  if (index !== -1) array.splice(index, 1)
}