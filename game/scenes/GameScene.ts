import { Scene } from "./Scene"
import { Entity } from "../entities/Entity"
import { Worm } from "../entities/Worm"
import { Wall, isPointBlocked } from "../entities/Wall"
import { Star } from "../entities/Star"
import { Bubble } from "../entities/Bubble"
import { RevealSwitch } from "../entities/RevealSwitch"
import { EnemyWorm } from "../entities/EnemyWorm"
import { GuardWorm } from "../entities/GuardWorm"
import { Nest } from "../entities/Nest"
import { Ant } from "../entities/Ant"
import { SaveButton } from "../entities/SaveButton"
import { LevelDoorMarker } from "../entities/LevelDoorMarker"
import { Leaf } from "../entities/Leaf"
import { Puddle } from "../entities/Puddle"
import { Sky } from "../entities/Sky"
import { Container, Sprite, Text, TextStyle, Texture } from "pixi.js"
import {
  CELL_SIZE,
  GRASS_LINE_Y,
  STARTING_PIT_HALF_WIDTH,
  STARTING_PIT_DEPTH,
  LEVEL_DOOR_HALF_WIDTH,
  FIND_OPEN_SPOT_MAX_ATTEMPTS,
  STARS_PER_LEVEL,
  BUBBLES_PER_LEVEL,
  ENEMIES_PER_LEVEL,
  TERRAIN_STONE_BASE_CHANCE,
  TERRAIN_STONE_HEIGHT_FACTOR,
  TERRAIN_ORE_CHANCE,
  WORM_CAMERA_FOLLOW_LERP,
  WORM_FOCUS_ZOOM_SCALE,
  DIG_LEVEL_HEIGHT_MULTIPLIER,
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

  private hudContainer = new Container()
  private starsText?: Text
  private hintText?: Text
  private revealText?: Text
  private leavesText?: Text
  private collectedStars = 0
  private totalStars = 0
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

  // Загружаем сохранённый уровень только один раз — при самом первом
  // onCreate() (настоящая загрузка страницы). Рестарт после смерти вызывает
  // onCreate() повторно на том же экземпляре сцены и должен по-прежнему
  // начинать с уровня 0 червяком, а не с сохранённого прогресса.
  private hasCheckedSavedProgress = false

  protected onCreate(): void {
    const startLevel = this.hasCheckedSavedProgress ? 0 : this.loadSavedLevel()
    this.hasCheckedSavedProgress = true

    this.metaState = MetaState.NONE
    this.metaTimer = 0
    this.collectedStars = 0
    this.totalStars = 0
    this.carriedLeaves = 0
    this.lightRadius = this.baseLightRadius
    this.revealTimer = 0
    // Текст факела-выключателя переживал рестарт уровня: revealTimer тут
    // выше уже честно обнулён, но сам HUD-текст (тот же Text-объект, что и
    // до смерти) оставался видимым с застрявшим числом — updateReveal()
    // больше не трогает его, раз revealTimer <= 0, и счётчик "зависал"
    // навсегда, будто сломался (отсюда и жалоба "таймер лагает").
    if (this.revealText) this.revealText.visible = false
    if (this.leavesText) this.leavesText.visible = false
    this.worldContainer.scale.set(1)
    this.worldContainer.pivot.set(0, 0)

    this.container.addChild(this.worldContainer)

    this.setupFog()
    this.setupHud()

    if (startLevel >= 1) {
      // Сохранение доступно только муравью, кнопкой (SaveButton) — значит,
      // если прогресс сохранён, начинать нужно сразу муравьём на
      // сохранённом уровне, а не заново копать червяком с нуля.
      this.levelIndex = startLevel
      // Единственный вертикальный переход (0→1) уже позади — сколько бы
      // горизонтальных уровней ни было пройдено дальше, Y-смещение всегда
      // равно ровно одной (увеличенной) высоте уровня копания.
      this.currentLevelYOffset = -(window.innerHeight * DIG_LEVEL_HEIGHT_MULTIPLIER)
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
        // Уровень 0 теперь выше обычного экрана (DIG_LEVEL_HEIGHT_MULTIPLIER) —
        // старт по-прежнему у самого дна уровня, просто дно теперь ниже.
        this.activePlayer.container.y = window.innerHeight * DIG_LEVEL_HEIGHT_MULTIPLIER - 80
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
    const width = window.innerWidth
    // Уровни 0/1 (подземное копание) теперь выше обычного экрана — есть где
    // копать, а не упираться в потолок почти сразу. Ширина не трогается:
    // она общая для обоих уровней и должна совпадать, иначе не совпадут и
    // X-координаты дверного проёма между ними (см. doorMinX/doorMaxX ниже).
    const height = level <= 1 ? window.innerHeight * DIG_LEVEL_HEIGHT_MULTIPLIER : window.innerHeight

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
          if (localY >= height - this.cellSize) {
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "bedrock"))
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
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "stone"))
            continue
          }

          const heightFactor = (height - localY) / height
          const stoneChance = TERRAIN_STONE_BASE_CHANCE + TERRAIN_STONE_HEIGHT_FACTOR * heightFactor
          const oreChance = TERRAIN_ORE_CHANCE
          const roll = Math.random()
          const type = roll < stoneChance ? "stone" : roll < stoneChance + oreChance ? "ore" : "dirt"

          this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, type))
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

          if (localY < this.grassLineY) continue

          if (localY === this.grassLineY) {
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "grass"))
            continue
          }

          if (isEdgeColumn) {
            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "stone"))
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

            this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, "bedrock"))
            continue
          }

          const sandRoll = Math.random()
          const type = sandRoll < TERRAIN_STONE_BASE_CHANCE ? "stone" : sandRoll < TERRAIN_STONE_BASE_CHANCE + TERRAIN_ORE_CHANCE ? "ore" : "sand"
          this.addEntity(new Wall(x, y, this.cellSize, this.cellSize, type))
        }
      }
    } else if (level >= 2) {
      // Уровень 3 (индекс 2) и дальше — открытая поверхность, продолжение
      // уровня 1 вправо: та же линия травы на той же высоте, голубое небо с
      // облаками вместо пустоты. Из препятствий — лужи прямо в линии травы:
      // муравей не проходит сквозь них, пока не наведёт мостик из подобранного
      // по пути листа (Leaf/Puddle, см. GameScene.update).
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
    }

    // Кнопка сохранения — только на поверхности (уровни 1+, где ходит
    // муравей), одна на сегмент. Стоит примерно посередине сегмента, чуть
    // выше линии травы.
    if (level >= 1) {
      this.addEntity(new SaveButton(startX + width / 2, startY + this.grassLineY - 6))
    }

    // Видимые границы сегмента поверхности — раньше муравья просто держали
    // невидимые координатные рамки (minX/maxX в update()), без всякой
    // видимой стены, и было непонятно, почему он вдруг перестаёт идти
    // дальше. Ставим настоящую (бедрок — та же "предупреждающая лента", что
    // и на границах уровня 0/1) стену от неба до травы по обеим сторонам
    // сегмента — Ant не проверяет столкновения со стенами, так что это
    // чисто визуальный ориентир, реальную границу по-прежнему считает
    // GameScene.update(). Левый край закрыт всегда — возвращаться в начало
    // сегмента незачем. Правый край закрыт, только если дальше пока некуда
    // идти: на уровне 1 там как раз переход на уровень 2, его закрывать
    // нельзя.
    if (level >= 1) {
      const addBoundaryColumn = (columnX: number) => {
        // До линии травы, не включая её саму, — там уже стоит "grass" на
        // всю ширину сегмента, дублировать/перекрывать эту клетку не надо.
        for (let y = startY; y < startY + this.grassLineY; y += this.cellSize) {
          this.addEntity(new Wall(columnX, y, this.cellSize, this.cellSize, "bedrock"))
        }
      }

      addBoundaryColumn(startX)

      if (level !== 1) {
        addBoundaryColumn(startX + width - this.cellSize)
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

    for (let i = 0; i < STARS_PER_LEVEL; i++) {
      const randomX = startX + Math.random() * (width - 100) + 50
      const randomY = startY + starLocalYMin + Math.random() * starLocalYRange
      this.addEntity(new Star(randomX, randomY))
      this.totalStars++
    }

    // Пузырьки света — та же зона, что и звёзды (только там, где есть земля
    // для копания), но их всего 3: это редкий бонус на уровень.
    for (let i = 0; i < BUBBLES_PER_LEVEL; i++) {
      const randomX = startX + Math.random() * (width - 100) + 50
      const randomY = startY + starLocalYMin + Math.random() * starLocalYRange
      this.addEntity(new Bubble(randomX, randomY))
    }

    // Факел-выключатель — один на уровень: подобрал — минуту видно всю
    // карту без тумана войны.
    {
      const randomX = startX + Math.random() * (width - 100) + 50
      const randomY = startY + starLocalYMin + Math.random() * starLocalYRange
      this.addEntity(new RevealSwitch(randomX, randomY))
    }

    // Вражеские червяки и их домик ходят/стоят только по уже открытым (не
    // занятым стеной) клеткам — поэтому обязательно спавним их в открытом
    // месте, иначе им будет некуда шагнуть и они замрут на месте навсегда.
    // На старте уровня 0 открыта обычно только маленькая стартовая яма (и
    // полоска в самом верху) — сэмплируем по всей потенциальной высоте
    // уровня, а не по узкой зоне звёзд, иначе шанс попасть в яму почти нулевой.
    const levelWalls = this.entities.filter((e): e is Wall => e instanceof Wall)
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
      let x = startX + Math.random() * (width - 100) + 50
      let y = startY + localYMin + Math.random() * range

      for (let attempt = 0; attempt < FIND_OPEN_SPOT_MAX_ATTEMPTS; attempt++) {
        if (!isPointBlocked(levelWalls, x, y)) break
        x = startX + Math.random() * (width - 100) + 50
        y = startY + localYMin + Math.random() * range
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
        x: Math.min(maxX, Math.max(minX, nestSpot.x + (Math.random() * 2 - 1) * ENEMY_NEST_SPAWN_RADIUS)),
        y: Math.min(maxY, Math.max(minY, nestSpot.y + (Math.random() * 2 - 1) * ENEMY_NEST_SPAWN_RADIUS)),
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
    const guard = new GuardWorm(guardSpot.x, guardSpot.y, enemyAreaTop, enemyAreaHeight)
    this.addEntity(guard)
    guard.init()

    for (let i = 0; i < ENEMIES_PER_LEVEL; i++) {
      const spot = findOpenSpotNearNest(enemyLocalYMin, enemyLocalYMax)
      const enemy = new EnemyWorm(spot.x, spot.y, enemyAreaTop, enemyAreaHeight, nestSpot.x, nestSpot.y)
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

    this.container.addChild(this.hudContainer)
  }

  private updateHud(): void {
    if (this.starsText) {
      this.starsText.text = `⭐ ${this.collectedStars}/${this.totalStars}`
    }

    if (this.leavesText) {
      this.leavesText.visible = this.levelIndex >= 2
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
        }
        break

      case MetaState.ZOOM_OUT:
        // Название состояния осталось от старой версии (когда камера
        // действительно зумилась обратно до 1x) — теперь же она, наоборот,
        // доводится ДО antFocusZoomScale (15x — больше пикового зума самого
        // превращения, 9x) и остаётся там: муравей всегда в фокусе камеры,
        // она не возвращается к обычному виду всего экрана.
        if (this.worldContainer.scale.x < this.antFocusZoomScale) {
          const zoomSpeed = deltaTime * META_ZOOM_SPEED
          this.worldContainer.scale.x += zoomSpeed
          this.worldContainer.scale.y += zoomSpeed

          this.worldContainer.pivot.set(playerX, playerY)
          this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)
        } else {
          this.worldContainer.scale.set(this.antFocusZoomScale)
          this.worldContainer.pivot.set(playerX, playerY)
          this.worldContainer.position.set(window.innerWidth / 2, window.innerHeight / 2)

          // ИСПРАВЛЕНО: Сбрасываем стейт в NONE вместо COMPLETE, чтобы разблокировать апдейты игры и вернуть управление
          this.metaState = MetaState.NONE
        }
        break

      case MetaState.COMPLETE:
        break
    }
  }

  private restartLevel(): void {
    this.worldContainer.removeChildren()
    this.entities = []
    this.deathTimer = 0
    this.onCreate()
  }

  public update(deltaTime: number): void {
    this.updateReveal(deltaTime)
    this.updateFog()

    if (this.metaState !== MetaState.NONE) {
      this.handleMetamorphosis(deltaTime)
      return
    }

    if (this.activePlayer && this.activePlayer.isDead) {
      this.deathTimer += deltaTime
      if (this.deathTimer >= DEATH_RESTART_DELAY) {
        this.restartLevel()
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

      if (this.activePlayer.container.y <= this.currentLevelYOffset + 40) {
        if (this.collectedStars < this.totalStars) {
          // Не все звёзды текущего уровня собраны — невидимая стена не
          // пускает наверх, пока игрок не соберёт оставшиеся.
          this.activePlayer.container.y = this.currentLevelYOffset + 40
          if (this.hintText) this.hintText.visible = true
        } else {
          // Камера и так уже плавно следует за червяком (см. followLerp
          // ниже) — отдельного "панорамного" перехода не нужно, она
          // естественно нагонит его на новом (увеличенном) уровне сама же.
          this.levelIndex++

          this.currentLevelYOffset -= window.innerHeight * DIG_LEVEL_HEIGHT_MULTIPLIER

          const safeYBound = this.currentLevelYOffset + window.innerHeight * DIG_LEVEL_HEIGHT_MULTIPLIER * 2
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

    if (this.activePlayer && this.entities.includes(this.activePlayer)) {
      const visibleStarsBefore = stars.reduce((count, star) => count + (star.container.visible ? 1 : 0), 0)

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

      const visibleStarsAfter = stars.reduce((count, star) => count + (star.container.visible ? 1 : 0), 0)
      const newlyCollected = visibleStarsBefore - visibleStarsAfter

      if (newlyCollected > 0) {
        this.collectedStars += newlyCollected
        this.updateHud()
      }

      // Пузырьки света не встроены в логику Worm.update — подбираем их прямо
      // тут через обычное AABB-пересечение и сразу расширяем радиус тумана.
      const bubbles = this.entities.filter((e): e is Bubble => e instanceof Bubble)
      for (const bubble of bubbles) {
        if (bubble.container.visible && this.activePlayer.isColliding(bubble)) {
          bubble.container.visible = false
          this.lightRadius += this.lightRadiusPerBubble
          this.rebuildFogTexture()
          console.log("Пузырёк света собран! Радиус видимости увеличен.")
        }
      }

      // Факел-выключатель — так же, отдельным AABB-пересечением: подобрал —
      // на минуту туман войны полностью выключается.
      const revealSwitches = this.entities.filter((e): e is RevealSwitch => e instanceof RevealSwitch)
      for (const revealSwitch of revealSwitches) {
        if (revealSwitch.container.visible && this.activePlayer.isColliding(revealSwitch)) {
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
      if (entity !== this.activePlayer && !(entity instanceof GuardWorm)) {
        // Передаём стены и звёзды всем сущностям — они не обязаны их
        // использовать (Wall/Star/Bubble/Nest их игнорируют), но вражеским
        // червякам это нужно: стены — чтобы не лезть сквозь непрокопанную
        // землю, звёзды — чтобы было что воровать (кроме уже сложенных у
        // домика — см. stealableStars выше). Стражей (GuardWorm) сюда не
        // пускаем — у них отдельный tick() ниже, реагирующий только на игрока.
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

    if (nest) {
      const storedCount = stars.reduce(
        (count, star) =>
          count + (star.container.visible && Math.hypot(star.container.x - nest.container.x, star.container.y - nest.container.y) <= NEST_STORAGE_RADIUS ? 1 : 0),
        0,
      )
      nest.setStoredCount(storedCount)
    }
  }
}
