import { AnimatedSprite, Assets, type Spritesheet, type Texture } from "pixi.js"
import { Entity } from "./Entity"
import { InputManager } from "../input/InputManager"
import { findWallAt, type Wall, type WallLookup } from "./Wall"
import { PlayerCosmetics, type PartnerRole } from "./PlayerCosmetics"
import { WORM_SPEED, WORM_DIG_HIT_INTERVAL, REMOTE_PLAYER_SMOOTHING } from "../config/GameConfig"

type AnimationState = "idle" | "walk" | "dead"

export class Worm extends Entity {
  // Спрайт центрирован (sprite.anchor.set(0.5) — см. init()), поэтому
  // container.x/y — это его центр, а не левый верхний угол; getBounds()
  // должен знать об этом же самом центрировании (см. Entity.originX/Y),
  // иначе рамка столкновений съезжала бы вправо-вниз от того, что реально
  // видно на экране.
  protected override originX = 0.5
  protected override originY = 0.5

  private speed = WORM_SPEED
  /** Пузырёк скорости (co-op — общий на комнату) временно множит скорость —
   * см. GameScene.updateSpeedBoost. 1 = обычная скорость. */
  public speedMultiplier = 1

  private sprite?: AnimatedSprite
  private animationState: AnimationState = "idle"

  // Блок с прочностью больше 1 (руда) грызётся не мгновенно, а по одному
  // удару каждые digHitInterval секунд, пока держится нажатое направление.
  private diggingWall?: Wall
  private digProgress = 0
  private readonly digHitInterval = WORM_DIG_HIT_INTERVAL

  private readonly cosmetics = new PlayerCosmetics()

  constructor(private input: InputManager) {
    super()
  }

  /** Co-op: помечает этого червя как напарника — контур + аксессуар над
   * головой (см. PlayerCosmetics). Локальный игрок этот метод не вызывает —
   * он и так знает, кто он такой; отличать нужно только напарника. */
  public async applyRemoteLook(role: PartnerRole): Promise<void> {
    await this.init()
    if (this.sprite) await this.cosmetics.apply(this.sprite, role)
  }

  public async init(): Promise<void> {
    if (this.sprite) {
      return
    }

    const idleSheet = Assets.get("/assets/worm/idle/idle.json") as Spritesheet | undefined
    const walkSheet = Assets.get("/assets/worm/walk/walk.json") as Spritesheet | undefined
    const deadSheet = Assets.get("/assets/worm/dead/dead.json") as Spritesheet | undefined

    const idleFrames = this.getFrames(idleSheet, "idle")
    const walkFrames = this.getFrames(walkSheet, "walk")
    const deadFrames = this.getFrames(deadSheet, "dead")

    const initialFrames = idleFrames.length ? idleFrames : walkFrames.length ? walkFrames : deadFrames

    if (!initialFrames.length) {
      return
    }

    this.sprite = new AnimatedSprite(initialFrames)

    this.sprite.anchor.set(0.5)
    this.sprite.animationSpeed = 0.18
    this.sprite.loop = true
    this.sprite.play()

    this.width = this.sprite.width
    this.height = this.sprite.height

    this.container.addChild(this.sprite)
  }

  /**
   * Подбор звезды сюда больше не входит — GameScene сам делает это через
   * единый tryPickupStar() (см. GameScene.update()), а не по diff'у
   * видимости, который раньше приходилось пересоздавать здесь неявно.
   */
  public update(deltaTime: number, wallLookup: WallLookup): void {
    if (this.animationState === "dead") {
      return
    }

    const moveSpeed = this.speed * this.speedMultiplier * deltaTime

    let moving = false
    let nextX = this.container.x
    let nextY = this.container.y

    // Сенсорный джойстик (мобилка/планшет) шлёт непрерывный аналоговый
    // вектор — червяк может ходить под любым углом (360°), а не только по
    // 4 направлениям, как на клавиатуре. На десктопе этот вектор всегда
    // null, так что WASD-поведение ниже не меняется.
    const analog = this.input.getAnalogVector()

    if (analog) {
      this.container.rotation = Math.atan2(analog.y, analog.x)
      nextX += analog.x * moveSpeed
      nextY += analog.y * moveSpeed
      moving = true
    } else if (this.input.isDown("KeyW")) {
      this.container.rotation = -Math.PI / 2
      nextY -= moveSpeed
      moving = true
    } else if (this.input.isDown("KeyS")) {
      this.container.rotation = Math.PI / 2
      nextY += moveSpeed
      moving = true
    } else if (this.input.isDown("KeyA")) {
      this.container.rotation = Math.PI
      nextX -= moveSpeed
      moving = true
    } else if (this.input.isDown("KeyD")) {
      this.container.rotation = 0
      nextX += moveSpeed
      moving = true
    }

    if (!this.sprite) {
      return
    }

    const nextState: AnimationState = moving ? "walk" : "idle"

    if (this.animationState !== nextState) {
      this.animationState = nextState
      this.applyAnimation(nextState)
    }

    let shouldMove = true

    // Определяем, в какую именно клетку сетки попадает точка червя, а не какие
    // стены пересекаются с его прямоугольником. Прямоугольное пересечение
    // ломается, когда червь оказывается ровно на границе сетки (например,
    // спавнится по центру экрана, кратному размеру клетки, или проходит по
    // ровной линии) — тогда бокс задевает сразу два соседних блока и оба
    // прогрызаются за пару кадров. Точка же всегда принадлежит ровно одной
    // клетке, поэтому за один шаг может быть прогрызен только один блок.
    const hitWall = findWallAt(wallLookup, nextX, nextY)

    if (hitWall) {
      if (hitWall.type === "stone") {
        this.animationState = "dead"
        this.applyAnimation("dead")
        this.sprite.loop = false
        shouldMove = false
        this.diggingWall = undefined
        this.digProgress = 0
      } else if (hitWall.type === "bedrock") {
        // Граница уровня — не грызётся и не убивает, просто не пускает
        // дальше (в отличие от камня).
        shouldMove = false
        this.diggingWall = undefined
        this.digProgress = 0
      } else if (hitWall.maxHitPoints > 1) {
        // Многоударный блок (руда): нельзя пройти сквозь него сразу — нужно
        // "прогрызать" его на месте, удар раз в digHitInterval секунд.
        shouldMove = false

        if (this.diggingWall !== hitWall) {
          this.diggingWall = hitWall
          this.digProgress = 0
        }

        this.digProgress += deltaTime

        if (this.digProgress >= this.digHitInterval) {
          this.digProgress = 0
          const destroyed = hitWall.hit()
          if (destroyed) {
            this.diggingWall = undefined
            shouldMove = true
          }
        }
      } else {
        hitWall.hit()
        shouldMove = true
        this.diggingWall = undefined
        this.digProgress = 0
      }
    } else {
      this.diggingWall = undefined
      this.digProgress = 0
    }

    if (shouldMove && moving) {
      this.container.x = nextX
      this.container.y = nextY
    }
  }

  private getFrames(sheet: Spritesheet | undefined, animationName: AnimationState): Texture[] {
    return (sheet?.animations?.[animationName] ?? []).filter((texture): texture is Texture => Boolean(texture))
  }

  public get isDead(): boolean {
    return this.animationState === "dead"
  }

  /**
   * Ставит червя в позицию, полученную по сети (напарник в co-op), — не
   * копание/столкновения, вся физика уже честно посчитана на ЕГО клиенте
   * (свои собственные, отдельно сгенерированные стены), нам остаётся только
   * отрисовать результат: позицию + анимацию ходьбы по факту смещения между
   * кадрами (в отличие от обычного update(), тут нет ни клавиатуры, ни
   * джойстика — только "куда сместился с прошлого раза"). x/y — уже
   * интерполированная (и ограниченно экстраполированная — см.
   * GameNetworkStore.getRemotePlayerStates) цель, а не сырой снапшот; сюда же
   * доводимся ПЛАВНО (REMOTE_PLAYER_SMOOTHING), а не телепортом — иначе
   * редкая, но заметная коррекция после лаг-спайка выглядела бы как
   * мгновенный прыжок, а не как естественное "нагнать".
   */
  public setRemotePosition(x: number, y: number, deltaTime: number): void {
    if (!this.sprite || this.animationState === "dead") return

    const dx = x - this.container.x
    const dy = y - this.container.y
    const moving = Math.hypot(dx, dy) > 0.5

    if (moving) {
      this.container.rotation = Math.atan2(dy, dx)
    }

    const nextState: AnimationState = moving ? "walk" : "idle"
    if (this.animationState !== nextState) {
      this.animationState = nextState
      this.applyAnimation(nextState)
    }

    const smoothing = Math.min(1, REMOTE_PLAYER_SMOOTHING * deltaTime)
    this.container.x += dx * smoothing
    this.container.y += dy * smoothing
  }

  /** Убивает червя извне (например, столкновение со стражем) — тот же путь, что и смерть от камня. */
  public kill(): void {
    if (this.animationState === "dead") {
      return
    }

    this.animationState = "dead"
    this.applyAnimation("dead")

    if (this.sprite) {
      this.sprite.loop = false
    }

    this.diggingWall = undefined
    this.digProgress = 0
  }

  private applyAnimation(state: AnimationState): void {
    if (!this.sprite) {
      return
    }

    const frames =
      state === "walk"
        ? this.getFrames(Assets.get("/assets/worm/walk/walk.json") as Spritesheet | undefined, "walk")
        : state === "dead"
          ? this.getFrames(Assets.get("/assets/worm/dead/dead.json") as Spritesheet | undefined, "dead")
          : this.getFrames(Assets.get("/assets/worm/idle/idle.json") as Spritesheet | undefined, "idle")

    if (!frames.length) {
      return
    }

    this.sprite.textures = frames
    this.sprite.animationSpeed = state === "walk" ? 0.18 : 0.12
    this.sprite.loop = state !== "dead"
    this.sprite.play()
  }
}
