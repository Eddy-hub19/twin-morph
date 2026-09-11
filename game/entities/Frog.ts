import { Assets, AnimatedSprite, Container, Texture } from "pixi.js"
import { Entity } from "./Entity"
import { PlayerCosmetics, type PartnerRole } from "./PlayerCosmetics"
import { FROG_SPEED, FROG_DESIRED_HEIGHT, FROG_ANALOG_DEADZONE } from "../config/GameConfig"

const DESIRED_HEIGHT = FROG_DESIRED_HEIGHT

// Кадры цикла плавания, сгенерированные scripts/generateFrogSwimFrames.js из
// public/assets/frog/frog-flat.svg. Кадр 0 — нейтральная поза (= frog-flat.svg),
// остальные — покадровый гребок задних лапок (тот же приём, что и у ходьбы
// муравья, см. Ant/walk-flat).
const SWIM_FRAME_COUNT = 6
const SWIM_FRAME_PATHS = Array.from({ length: SWIM_FRAME_COUNT }, (_, i) => `/assets/frog/swim-flat/frame-${i}.svg`)

/**
 * Жаба — форма игрока на уровне 4+ (индекс 3+), после метаморфозы из
 * муравья на правом краю уровня 3 (см. GameScene.handleMetamorphosis). В
 * отличие от муравья (который идёт только по одной линии травы), жаба
 * свободно плавает во всей толще воды — движение считается по обеим осям
 * сразу, а не только по X.
 *
 * В co-op напарник, дошедший до воды, — тот же самый класс Frog (не
 * отдельный "призрак"-объект), просто ведомый setRemotePosition() вместо
 * ввода — см. GameScene.upsertRemoteEntity/PlayerForm.
 */
export class Frog extends Entity {
  public isDead = false

  private sprite!: AnimatedSprite

  private vx = 0
  private vy = 0
  private speed = FROG_SPEED
  private input: any

  private readonly cosmetics = new PlayerCosmetics()
  private spriteReady!: Promise<void>

  constructor(input: any, x: number, y: number) {
    super()
    this.container = new Container()
    this.container.x = x
    this.container.y = y
    this.input = input

    this.spriteReady = this.setupSprite()
  }

  /** Co-op: помечает эту жабу как напарника — контур + аксессуар над головой
   * (см. PlayerCosmetics), тот же приём, что и Worm.applyRemoteLook/
   * Ant.applyRemoteLook. Локальный игрок этот метод не вызывает. */
  public async applyRemoteLook(role: PartnerRole): Promise<void> {
    await this.spriteReady
    if (this.sprite) await this.cosmetics.apply(this.sprite, role)
  }

  /** Убивает жабу извне — задел на будущее (сейчас на уровне воды ничего не
   * атакует игрока), для единообразия с Worm.kill()/Ant.kill(). */
  public kill(): void {
    if (this.isDead) return
    this.isDead = true

    if (this.sprite) {
      this.sprite.stop()
    }
  }

  private async setupSprite(): Promise<void> {
    const loadAll = async (paths: string[]) =>
      Promise.all(paths.map(async (path) => ((Assets.get(path) as Texture | undefined) ?? (await Assets.load(path))) as Texture))

    const swimTextures = await loadAll(SWIM_FRAME_PATHS)

    this.sprite = new AnimatedSprite(swimTextures)
    // Якорь по центру — жаба висит в толще воды, а не стоит на земле, как муравей.
    this.sprite.anchor.set(0.5)
    this.sprite.animationSpeed = 0.18
    this.sprite.loop = true
    this.sprite.gotoAndStop(0)

    this.container.addChild(this.sprite)

    this.applyTextureScale(swimTextures[0])

    // Без этого isColliding() (сейчас не используется на уровне воды, но
    // держим корректным для единообразия с Worm/Ant) видел бы нулевую коробку.
    this.width = this.sprite.width
    this.height = this.sprite.height
  }

  private applyTextureScale(texture: Texture): void {
    if (!texture.height) return

    const scaleFactor = DESIRED_HEIGHT / texture.height
    this.sprite.scale.set(scaleFactor)
  }

  public update(deltaTime: number): void {
    // Защита: пока спрайт не загрузился, ничего не делаем.
    if (!this.sprite || this.isDead) return

    this.vx = 0
    this.vy = 0
    let isMoving = false

    // Сенсорный джойстик шлёт аналоговый вектор по обеим осям сразу — в
    // отличие от муравья, жаба плавает свободно (вверх/вниз тоже), поэтому
    // используем и analog.x, и analog.y, а не только X.
    const analog = this.input.getAnalogVector ? this.input.getAnalogVector() : null

    if (this.input.isDown("ArrowLeft") || this.input.isDown("KeyA") || (analog !== null && analog.x < -FROG_ANALOG_DEADZONE)) {
      const magnitude = analog !== null && analog.x < 0 ? Math.min(1, -analog.x) : 1
      this.vx = -this.speed * deltaTime * magnitude
      // Спрайт нарисован головой вправо — разворачиваем влево отражением.
      this.sprite.scale.x = -Math.abs(this.sprite.scale.y)
      isMoving = true
    }
    if (this.input.isDown("ArrowRight") || this.input.isDown("KeyD") || (analog !== null && analog.x > FROG_ANALOG_DEADZONE)) {
      const magnitude = analog !== null && analog.x > 0 ? Math.min(1, analog.x) : 1
      this.vx = this.speed * deltaTime * magnitude
      this.sprite.scale.x = Math.abs(this.sprite.scale.y)
      isMoving = true
    }
    if (this.input.isDown("ArrowUp") || this.input.isDown("KeyW") || (analog !== null && analog.y < -FROG_ANALOG_DEADZONE)) {
      const magnitude = analog !== null && analog.y < 0 ? Math.min(1, -analog.y) : 1
      this.vy = -this.speed * deltaTime * magnitude
      isMoving = true
    }
    if (this.input.isDown("ArrowDown") || this.input.isDown("KeyS") || (analog !== null && analog.y > FROG_ANALOG_DEADZONE)) {
      const magnitude = analog !== null && analog.y > 0 ? Math.min(1, analog.y) : 1
      this.vy = this.speed * deltaTime * magnitude
      isMoving = true
    }

    this.container.x += this.vx
    this.container.y += this.vy

    // Границы сегмента (по X и Y) считает GameScene — тот же принцип, что и
    // у муравья по X (см. Ant.update): свои жёстко зашитые границы тут не
    // подходят, они завязаны на смещение текущего сегмента камеры.

    // Настоящий цикл плавания (покадровый гребок задних лапок) — играем,
    // пока жаба движется, замираем на позе покоя, когда она стоит на месте.
    if (isMoving) {
      if (!this.sprite.playing) this.sprite.play()
    } else if (this.sprite.playing) {
      this.sprite.gotoAndStop(0)
    }
  }

  /** Ставит жабу в позицию, полученную по сети — задел на будущее (co-op на
   * уровне воды сейчас не поддержан, см. комментарий у класса), по образцу
   * Ant.setRemotePosition/Worm.setRemotePosition. */
  public setRemotePosition(x: number, y: number): void {
    if (!this.sprite || this.isDead) return

    const dx = x - this.container.x
    const isMoving = Math.hypot(dx, y - this.container.y) > 0.3

    if (isMoving) {
      this.sprite.scale.x = dx < 0 ? -Math.abs(this.sprite.scale.y) : Math.abs(this.sprite.scale.y)
      if (!this.sprite.playing) this.sprite.play()
    } else if (this.sprite.playing) {
      this.sprite.gotoAndStop(0)
    }

    this.container.x = x
    this.container.y = y
  }
}
