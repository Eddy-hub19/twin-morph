import { Assets, AnimatedSprite, Container, Graphics, Sprite, Texture } from "pixi.js"
import { Entity } from "./Entity"
import { PlayerCosmetics, type PartnerRole } from "./PlayerCosmetics"
import type { MaterialKind } from "./Material"
import {
  ANT_SPEED,
  ANT_DESIRED_HEIGHT,
  ANT_DEAD_ANIMATION_SPEED,
  ANT_MAX_DEATH_ROTATION_DEG,
  ANT_LEAF_SCALE,
  ANT_LEAF_DURATION,
  ANT_LEAF_RISE,
  ANT_ANALOG_DEADZONE,
  DROWN_FLAIL_DURATION,
  DROWN_SINK_DEPTH,
  MATERIAL_SIZE,
  REMOTE_PLAYER_SMOOTHING,
} from "../config/GameConfig"

const DESIRED_HEIGHT = ANT_DESIRED_HEIGHT

// Кадры цикла ходьбы, сгенерированные scripts/generateAntWalkFrames.js из
// public/assets/ant/ant-flat.svg. Кадр 0 — нейтральная поза (= ant-flat.svg),
// остальные — покадровый поворот ножек/усиков и лёгкое покачивание тела.
const WALK_FRAME_COUNT = 8
const WALK_FRAME_PATHS = Array.from(
  { length: WALK_FRAME_COUNT },
  (_, i) => `/assets/ant/walk-flat/frame-${i}.svg`,
)

// Кадры анимации смерти, сгенерированные scripts/generateAntDeathFrames.js.
// Тут меняются только ножки (поджимаются) и глаз (крестик) — сам "завал на
// спину" крутит не SVG, а PixiJS через sprite.rotation (см. kill()), иначе
// пришлось бы раздувать viewBox под поворот на ~150° и потом городить
// отдельный масштаб под этот кадр.
const DEAD_FRAME_COUNT = 6
const DEAD_FRAME_PATHS = Array.from(
  { length: DEAD_FRAME_COUNT },
  (_, i) => `/assets/ant/dead-flat/frame-${i}.svg`,
)
const DEAD_ANIMATION_SPEED = ANT_DEAD_ANIMATION_SPEED
const MAX_DEATH_ROTATION = (ANT_MAX_DEATH_ROTATION_DEG * Math.PI) / 180

const LEAF_PATH = "/assets/ant/leaf.svg"
const LEAF_SCALE = ANT_LEAF_SCALE
const LEAF_DURATION = ANT_LEAF_DURATION // секунд — сколько висит листочек на усике после подбора звезды
const LEAF_RISE = ANT_LEAF_RISE // px, на сколько листочек всплывает вверх за время показа

// Нижняя точка ножек (самая большая y-координата среди путей ног в
// ant-flat.svg/walk-flat/*, поза покоя) — якорь спрайта ставим сюда, а не на
// глаз "0.85", иначе муравей визуально висит над травой (его реальные ноги
// заметно ниже 85% высоты текстуры).
const FEET_FY = (50 + 10) / 62

// Кончик уса в координатах viewBox ant-flat.svg (0 -10 100 62) — сюда
// цепляем листочек. Взято по позе покоя (кадр 0 цикла ходьбы).
const ANTENNA_TIP_FX = 90 / 100
const ANTENNA_TIP_FY = (-1 + 10) / 62

// Точка "у щелепах" — ниже и чуть ближе к телу, чем кончик уса (материал,
// который муравей несёт на уровне пруда/моста, см. setCarriedMaterial).
const JAWS_FX = 78 / 100
const JAWS_FY = (20 + 10) / 62

export class Ant extends Entity {
  // Тот же якорь, что и у sprite.anchor.set(0.5, 0.85) ниже (см. init()) —
  // муравей стоит на земле ножками, container.y — не центр тела, а точка
  // чуть выше них. См. комментарий у Entity.originX/Y и Worm.originX/Y —
  // без этого рамка столкновений считала бы container.y верхним краем
  // спрайта и съезжала бы вниз от того, что реально видно.
  protected override originX = 0.5
  protected override originY = 0.85

  public isDead = false
  /** true, если последняя смерть — утопление в пруду (уровень 3, индекс 2):
   * GameScene по этому флагу решает респавнить муравья на чекпоинте, а не
   * перезапускать весь уровень/комнату (см. GameScene.update). */
  public diedFromDrowning = false

  private sprite!: AnimatedSprite
  private leafSprite?: Sprite
  private deadTextures: Texture[] = []
  private leafTimer = 0
  /** Множитель scale.set() спрайта из applyTextureScale — сохраняем отдельно,
   * чтобы во время утопления домножать на него (сжатие при погружении), не
   * теряя исходный масштаб под ANT_DESIRED_HEIGHT. */
  private baseScale = 1
  /** "Яма" в воде под ногами, куда муравей визуально уходит при утоплении —
   * см. drown()/finishDrowning(). */
  private pit!: Graphics

  /** "Борсается" перед тем, как утонуть (см. drown()) — во время этого
   * движение/подбор звёзд не обрабатываются, но isDead ещё false (иначе
   * GameScene тут же посчитал бы муравья мёртвым на первом же кадре). */
  private isDrowning = false
  private drownFlailTimer = 0

  private jawsSprite?: Graphics
  private carriedMaterialKind: MaterialKind | "bigBranch" | null = null

  private vx = 0
  private speed = ANT_SPEED
  /** Пузырёк скорости (co-op — общий на комнату) временно множит скорость —
   * см. GameScene.updateSpeedBoost. 1 = обычная скорость. */
  public speedMultiplier = 1
  private input: any

  private readonly cosmetics = new PlayerCosmetics()
  private spriteReady!: Promise<void>

  /** Убивает муравья извне (например, столкновение со стражем). */
  public kill(): void {
    if (this.isDead) return
    this.isDead = true

    // Листочек не должен продолжать всплывать над мёртвым муравьём.
    this.leafTimer = 0
    if (this.leafSprite) this.leafSprite.visible = false
    if (this.jawsSprite) this.jawsSprite.visible = false

    if (!this.sprite || !this.deadTextures.length) return

    this.sprite.textures = this.deadTextures
    this.sprite.loop = false
    this.sprite.animationSpeed = DEAD_ANIMATION_SPEED

    // Кадры смерти сами меняют только ножки/глаз — заваливание на спину
    // крутим тут же, синхронно со сменой кадра, чтобы поза и наклон совпадали.
    this.sprite.onFrameChange = (frame) => {
      this.sprite.rotation = (frame / (DEAD_FRAME_COUNT - 1)) * MAX_DEATH_ROTATION
    }
    this.sprite.onComplete = () => {
      this.sprite.rotation = MAX_DEATH_ROTATION
    }

    this.sprite.gotoAndPlay(0)
  }

  /**
   * Топит муравья (уровень 3, индекс 2 — пруд без наведённого моста): в
   * отличие от kill() не убивает мгновенно, а сперва даёт короткое время
   * "побарсаться" (DROWN_FLAIL_DURATION), за которое муравей уходит вниз в
   * "яму" (pit) под ногами — тонет, а не просто падает замертво на воде, как
   * от kill(). Всё это время сама update() не пускает муравья дальше/не даёт
   * подбирать предметы, но isDead ещё false. По истечении таймера
   * finishDrowning() честно ставит isDead/diedFromDrowning.
   */
  public drown(): void {
    if (this.isDead || this.isDrowning) return

    this.isDrowning = true
    this.drownFlailTimer = DROWN_FLAIL_DURATION
    this.leafTimer = 0
    if (this.leafSprite) this.leafSprite.visible = false
    if (this.jawsSprite) this.jawsSprite.visible = false

    this.pit.visible = true
    this.pit.alpha = 0
  }

  /** Завершает утопление (drownFlailTimer истёк) — прячет муравья и яму под
   * ним, без анимации "упал замертво", которую использует обычный kill()
   * (та рассчитана на смерть на суше от врага, не на уход под воду). */
  private finishDrowning(): void {
    this.isDrowning = false
    this.isDead = true
    this.diedFromDrowning = true
    this.sprite.visible = false
    this.pit.visible = false
  }

  constructor(input: any, x: number, y: number) {
    super()
    this.container = new Container()
    this.container.x = x
    this.container.y = y
    this.input = input

    this.spriteReady = this.setupSprite()
  }

  /** Co-op: помечает этого муравья как напарника — контур + аксессуар над
   * головой (см. PlayerCosmetics). Локальный игрок этот метод не вызывает —
   * отличать нужно только напарника, не себя самого. */
  public async applyRemoteLook(role: PartnerRole): Promise<void> {
    await this.spriteReady
    if (this.sprite) await this.cosmetics.apply(this.sprite, role)
  }

  private async setupSprite(): Promise<void> {
    const loadAll = async (paths: string[]) =>
      Promise.all(
        paths.map(
          async (path) => ((Assets.get(path) as Texture | undefined) ?? (await Assets.load(path))) as Texture,
        ),
      )

    const [walkTextures, deadTextures, leafTexture] = await Promise.all([
      loadAll(WALK_FRAME_PATHS),
      loadAll(DEAD_FRAME_PATHS),
      loadAll([LEAF_PATH]).then((textures) => textures[0]),
    ])

    this.deadTextures = deadTextures

    // "Яма" в воде под ногами — тёмное плоское пятно, скрытое, пока не
    // начнётся утопление (см. drown()); добавляем ДО спрайта муравья, чтобы
    // рисовалось под ним, а не поверх.
    this.pit = new Graphics()
    this.pit.visible = false
    this.container.addChild(this.pit)

    this.sprite = new AnimatedSprite(walkTextures)
    // Якорь внизу по центру — муравей стоит на земле своими ножками, а не
    // висит в воздухе серединой тела (см. FEET_FY — реальная нижняя точка
    // ножек в SVG, а не круглое число "0.85").
    this.sprite.anchor.set(0.5, FEET_FY)
    this.sprite.animationSpeed = 0.22
    this.sprite.loop = true
    // Кадр 0 — поза покоя, показываем её, пока муравей не пошёл.
    this.sprite.gotoAndStop(0)

    this.container.addChild(this.sprite)

    this.applyTextureScale(walkTextures[0])

    this.pit.clear()
    this.pit.beginFill(0x0c2f42, 0.6)
    this.pit.drawEllipse(0, 0, DESIRED_HEIGHT * 1.1, DESIRED_HEIGHT * 0.55)
    this.pit.endFill()

    this.leafSprite = new Sprite(leafTexture)
    this.leafSprite.anchor.set(0.5)
    this.leafSprite.visible = false
    this.container.addChild(this.leafSprite)

    this.jawsSprite = new Graphics()
    this.jawsSprite.visible = false
    this.container.addChild(this.jawsSprite)

    // Без этого isColliding() (используется для звёзд, пузырьков, кнопки
    // сохранения и т.п.) никогда не сработает — Entity.getBounds() строит
    // AABB из container.x/y + width/height, а по умолчанию width/height у
    // Entity равны 0, то есть коробка нулевого размера ни с чем не пересечётся.
    this.width = this.sprite.width
    this.height = this.sprite.height
  }

  private applyTextureScale(texture: Texture): void {
    if (!texture.height) return

    const scaleFactor = DESIRED_HEIGHT / texture.height
    this.baseScale = scaleFactor
    this.sprite.scale.set(scaleFactor)
  }

  /** Локальные координаты (в системе container) кончика уса — точка крепления листочка. */
  private getAntennaTipOffset(): { x: number; y: number } {
    const texture = this.sprite.texture
    const anchor = this.sprite.anchor

    return {
      x: (ANTENNA_TIP_FX - anchor.x) * texture.width * this.sprite.scale.x,
      y: (ANTENNA_TIP_FY - anchor.y) * texture.height * this.sprite.scale.y,
    }
  }

  /** Локальные координаты (в системе container) точки "у щелепах" — куда
   * крепится переносимый материал (лист/ветка/большая ветка), см.
   * setCarriedMaterial. Тот же приём, что и getAntennaTipOffset. */
  private getJawsOffset(): { x: number; y: number } {
    const texture = this.sprite.texture
    const anchor = this.sprite.anchor

    return {
      x: (JAWS_FX - anchor.x) * texture.width * this.sprite.scale.x,
      y: (JAWS_FY - anchor.y) * texture.height * this.sprite.scale.y,
    }
  }

  /**
   * Уровень 3 (индекс 2, пруд/мост): постоянный индикатор "муравей несёт
   * материал в щелепах", пока GameScene не установит его в слот моста или
   * не сбросит (утопление) — в отличие от leafSprite/leafTimer выше (та
   * механика — отдельный, уже существующий "поп" листочка после подбора
   * звезды, её не трогаем).
   */
  public setCarriedMaterial(kind: MaterialKind | "bigBranch" | null): void {
    this.carriedMaterialKind = kind
    if (!this.jawsSprite) return

    if (!kind) {
      this.jawsSprite.visible = false
      return
    }

    this.jawsSprite.clear()
    if (kind === "leaf") {
      this.jawsSprite.beginFill(0x5cb85c)
      this.jawsSprite.drawEllipse(0, 0, MATERIAL_SIZE / 2, MATERIAL_SIZE / 2.6)
      this.jawsSprite.endFill()
    } else {
      // "branch" и "bigBranch" рисуются одинаково (просто веточкой) — сама
      // большая ветка на уровне физически отдельная сущность (BigBranch),
      // тут лишь визуальный намёк, что муравей тоже её толкает.
      this.jawsSprite.lineStyle(3, 0x6b4a2b)
      this.jawsSprite.moveTo(-MATERIAL_SIZE / 2, MATERIAL_SIZE / 4)
      this.jawsSprite.lineTo(MATERIAL_SIZE / 2, -MATERIAL_SIZE / 4)
    }
    this.jawsSprite.visible = true
  }

  public get carriedMaterial(): MaterialKind | "bigBranch" | null {
    return this.carriedMaterialKind
  }

  /** true — муравей сейчас "борсается" после drown() (см. там же): GameScene
   * не должен запускать новые взаимодействия (подбор/установка материала,
   * толкание ветки, повторный триггер утопления) в это окно. */
  public get isFlailing(): boolean {
    return this.isDrowning
  }

  private updateCarriedMaterial(): void {
    if (!this.jawsSprite || !this.jawsSprite.visible) return
    const tip = this.getJawsOffset()
    this.jawsSprite.position.set(tip.x, tip.y)
  }

  /** Вызывается ИЗ GameScene.tryPickupStar() сразу по факту успешного подбора
   * звезды муравьём — на LEAF_DURATION секунд показывает листочек на усике
   * (сама звезда прячется/засчитывается в tryPickupStar, этот метод —
   * только визуальный отклик, тот же, что раньше срабатывал изнутри
   * update() при прямом столкновении со звездой). */
  public showLeafPickupEffect(): void {
    this.leafTimer = LEAF_DURATION
  }

  /** Обновляет позицию/прозрачность листочка, подобранного на усик, и гасит его по истечении таймера. */
  private updateLeaf(deltaTime: number): void {
    if (!this.leafSprite || this.leafTimer <= 0) return

    this.leafTimer = Math.max(0, this.leafTimer - deltaTime)

    const progress = 1 - this.leafTimer / LEAF_DURATION
    // Быстрый "поп" при появлении, плавное затухание в конце.
    const popScale = Math.min(1, progress / 0.2)
    const fadeAlpha = progress > 0.7 ? Math.max(0, 1 - (progress - 0.7) / 0.3) : 1
    const rise = progress * LEAF_RISE

    const tip = this.getAntennaTipOffset()

    this.leafSprite.visible = true
    this.leafSprite.alpha = fadeAlpha
    this.leafSprite.scale.set(LEAF_SCALE * popScale)
    this.leafSprite.position.set(tip.x, tip.y - rise)

    if (this.leafTimer <= 0) {
      this.leafSprite.visible = false
    }
  }

  /** Подбор звезды сюда больше не входит — единая точка теперь
   * GameScene.tryPickupStar(), которая сама зовёт showLeafPickupEffect()
   * ниже, когда подбор случился именно муравьём (см. GameScene.update()). */
  public update(deltaTime: number): void {
    // Защита: пока спрайт не загрузился, ничего не делаем
    if (!this.sprite) return

    // Мёртвый муравей не ходит и не подбирает звёзды — анимацию смерти
    // после kill() дальше ведёт сам Pixi (AnimatedSprite играет от своего
    // тикера), а не наш update(). GameScene и так больше не вызывает update()
    // после isDead, но проверяем и тут: без этой защиты случайный повторный
    // вызов update() тут же откатит анимацию смерти обратно на кадр покоя
    // веткой "иначе — gotoAndStop(0)" ниже.
    if (this.isDead) return

    if (this.isDrowning) {
      // Хаотичная хитавиця, затухающая по мере погружения (progress: 0 —
      // только начал тонуть, 1 — таймер истёк) — вместо ходьбы муравей
      // уходит вниз в яму под собой (sprite.y, не container.y — камера
      // следит за container каждый кадр, см. DROWN_SINK_DEPTH), сжимаясь и
      // растворяясь, а яма проступает под ним.
      this.drownFlailTimer -= deltaTime
      const progress = 1 - Math.max(0, this.drownFlailTimer) / DROWN_FLAIL_DURATION

      this.sprite.rotation = Math.sin(this.drownFlailTimer * 40) * 0.25 * (1 - progress)
      this.sprite.y = progress * DROWN_SINK_DEPTH
      this.sprite.alpha = 1 - progress
      this.sprite.scale.set(this.baseScale * (1 - progress * 0.4))
      this.pit.alpha = Math.min(1, progress * 2.5)

      if (this.drownFlailTimer <= 0) {
        this.finishDrowning()
      }
      return
    }

    this.vx = 0
    let isMoving = false

    // Сенсорный джойстик шлёт аналоговый вектор, а не WASD — муравей ходит
    // только по горизонтали, поэтому нас интересует только знак/сила X.
    const analog = this.input.getAnalogVector ? this.input.getAnalogVector() : null

    if (this.input.isDown("ArrowLeft") || this.input.isDown("KeyA") || (analog !== null && analog.x < -ANT_ANALOG_DEADZONE)) {
      const magnitude = analog !== null && analog.x < 0 ? Math.min(1, -analog.x) : 1
      this.vx = -this.speed * this.speedMultiplier * deltaTime * magnitude
      // Спрайт нарисован головой вправо — разворачиваем влево отражением.
      this.sprite.scale.x = -Math.abs(this.sprite.scale.y)
      isMoving = true
    }
    if (this.input.isDown("ArrowRight") || this.input.isDown("KeyD") || (analog !== null && analog.x > ANT_ANALOG_DEADZONE)) {
      const magnitude = analog !== null && analog.x > 0 ? Math.min(1, analog.x) : 1
      this.vx = this.speed * this.speedMultiplier * deltaTime * magnitude
      this.sprite.scale.x = Math.abs(this.sprite.scale.y)
      isMoving = true
    }

    this.container.x += this.vx

    // Борта экрана считает GameScene (там же, где решается переход на
    // следующий горизонтальный уровень) — свои фиксированные на
    // window.innerWidth границы тут не годятся: после первого же перехода
    // камера вправо смещается, и абсолютные координаты муравья перестают
    // совпадать с координатами экрана.

    // Настоящий цикл ходьбы (покадровый поворот ножек) — играем, пока
    // муравей движется, и замираем на позе покоя, когда он стоит.
    if (isMoving) {
      if (!this.sprite.playing) this.sprite.play()
    } else if (this.sprite.playing) {
      this.sprite.gotoAndStop(0)
    }

    this.updateLeaf(deltaTime)
    this.updateCarriedMaterial()
  }

  /**
   * Ставит муравья в позицию, полученную по сети (напарник в co-op) —
   * аналог Worm.setRemotePosition: своя физика (столкновения с лужами,
   * сбор листьев) уже честно посчитана на ЕГО клиенте, нам остаётся только
   * отрисовать результат — позицию по X и цикл ходьбы по факту смещения.
   * Доводимся до x плавно (REMOTE_PLAYER_SMOOTHING), а не телепортом — см.
   * тот же комментарий у Worm.setRemotePosition.
   */
  public setRemotePosition(x: number, deltaTime: number): void {
    if (!this.sprite || this.isDead || this.isDrowning) return

    const dx = x - this.container.x
    const isMoving = Math.abs(dx) > 0.3

    if (isMoving) {
      this.sprite.scale.x = dx < 0 ? -Math.abs(this.sprite.scale.y) : Math.abs(this.sprite.scale.y)
      if (!this.sprite.playing) this.sprite.play()
    } else if (this.sprite.playing) {
      this.sprite.gotoAndStop(0)
    }

    const smoothing = Math.min(1, REMOTE_PLAYER_SMOOTHING * deltaTime)
    this.container.x += dx * smoothing
  }
}
