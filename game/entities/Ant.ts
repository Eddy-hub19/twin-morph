import { Assets, AnimatedSprite, Container, Sprite, Texture } from "pixi.js"
import { Entity } from "./Entity"
import { Wall } from "./Wall"
import { Star } from "./Star"
import {
  ANT_SPEED,
  ANT_DESIRED_HEIGHT,
  ANT_DEAD_ANIMATION_SPEED,
  ANT_MAX_DEATH_ROTATION_DEG,
  ANT_LEAF_SCALE,
  ANT_LEAF_DURATION,
  ANT_LEAF_RISE,
  ANT_ANALOG_DEADZONE,
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

// Кончик уса в координатах viewBox ant-flat.svg (0 -10 100 62) — сюда
// цепляем листочек. Взято по позе покоя (кадр 0 цикла ходьбы).
const ANTENNA_TIP_FX = 90 / 100
const ANTENNA_TIP_FY = (-1 + 10) / 62

export class Ant extends Entity {
  public isDead = false

  private sprite!: AnimatedSprite
  private leafSprite?: Sprite
  private deadTextures: Texture[] = []
  private leafTimer = 0

  private vx = 0
  private speed = ANT_SPEED
  private input: any

  /** Убивает муравья извне (например, столкновение со стражем). */
  public kill(): void {
    if (this.isDead) return
    this.isDead = true

    // Листочек не должен продолжать всплывать над мёртвым муравьём.
    this.leafTimer = 0
    if (this.leafSprite) this.leafSprite.visible = false

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

  constructor(input: any, x: number, y: number) {
    super()
    this.container = new Container()
    this.container.x = x
    this.container.y = y
    this.input = input

    this.setupSprite()
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

    this.sprite = new AnimatedSprite(walkTextures)
    // Якорь внизу по центру — муравей стоит на земле своими ножками, а не
    // висит в воздухе серединой тела.
    this.sprite.anchor.set(0.5, 0.85)
    this.sprite.animationSpeed = 0.22
    this.sprite.loop = true
    // Кадр 0 — поза покоя, показываем её, пока муравей не пошёл.
    this.sprite.gotoAndStop(0)

    this.container.addChild(this.sprite)

    this.applyTextureScale(walkTextures[0])

    this.leafSprite = new Sprite(leafTexture)
    this.leafSprite.anchor.set(0.5)
    this.leafSprite.visible = false
    this.container.addChild(this.leafSprite)

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

  public update(deltaTime: number, walls: Wall[], stars: Star[]): void {
    // Защита: пока спрайт не загрузился, ничего не делаем
    if (!this.sprite) return

    // Мёртвый муравей не ходит и не подбирает звёзды — анимацию смерти
    // после kill() дальше ведёт сам Pixi (AnimatedSprite играет от своего
    // тикера), а не наш update(). GameScene и так больше не вызывает update()
    // после isDead, но проверяем и тут: без этой защиты случайный повторный
    // вызов update() тут же откатит анимацию смерти обратно на кадр покоя
    // веткой "иначе — gotoAndStop(0)" ниже.
    if (this.isDead) return

    this.vx = 0
    let isMoving = false

    // Сенсорный джойстик шлёт аналоговый вектор, а не WASD — муравей ходит
    // только по горизонтали, поэтому нас интересует только знак/сила X.
    const analog = this.input.getAnalogVector ? this.input.getAnalogVector() : null

    if (this.input.isDown("ArrowLeft") || this.input.isDown("KeyA") || (analog !== null && analog.x < -ANT_ANALOG_DEADZONE)) {
      const magnitude = analog !== null && analog.x < 0 ? Math.min(1, -analog.x) : 1
      this.vx = -this.speed * deltaTime * magnitude
      // Спрайт нарисован головой вправо — разворачиваем влево отражением.
      this.sprite.scale.x = -Math.abs(this.sprite.scale.y)
      isMoving = true
    }
    if (this.input.isDown("ArrowRight") || this.input.isDown("KeyD") || (analog !== null && analog.x > ANT_ANALOG_DEADZONE)) {
      const magnitude = analog !== null && analog.x > 0 ? Math.min(1, analog.x) : 1
      this.vx = this.speed * deltaTime * magnitude
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

    // Подобрал звезду — вместо неё на секунду показываем листочек на усике
    // (звезда всё так же считается собранной: GameScene сам заметит, что она
    // погасла, и обновит счётчик).
    for (const star of stars) {
      if (star.container.visible && this.isColliding(star)) {
        star.container.visible = false
        this.leafTimer = LEAF_DURATION
      }
    }

    this.updateLeaf(deltaTime)
  }
}
