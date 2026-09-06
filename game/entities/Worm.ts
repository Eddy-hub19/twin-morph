import { AnimatedSprite, Assets, type Spritesheet, type Texture } from "pixi.js"
import { Entity } from "./Entity"
import { InputManager } from "../input/InputManager"
import { Wall } from "./Wall"
import { Star } from "./Star"
import { WORM_SPEED, WORM_DIG_HIT_INTERVAL } from "../config/GameConfig"

type AnimationState = "idle" | "walk" | "dead"

export class Worm extends Entity {
  private speed = WORM_SPEED

  private sprite?: AnimatedSprite
  private animationState: AnimationState = "idle"

  // Блок с прочностью больше 1 (руда) грызётся не мгновенно, а по одному
  // удару каждые digHitInterval секунд, пока держится нажатое направление.
  private diggingWall?: Wall
  private digProgress = 0
  private readonly digHitInterval = WORM_DIG_HIT_INTERVAL

  constructor(private input: InputManager) {
    super()
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

  public update(deltaTime: number, walls: Wall[] = [], stars: Star[] = []): void {
    if (this.animationState === "dead") {
      return
    }

    const moveSpeed = this.speed * deltaTime

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
    const hitWall = this.findWallAtPoint(walls, nextX, nextY)

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

    for (const star of stars) {
      if (star.container.visible && this.isColliding(star)) {
        star.container.visible = false
        console.log("Звезда собрана!")
      }
    }
  }

  private getFrames(sheet: Spritesheet | undefined, animationName: AnimationState): Texture[] {
    return (sheet?.animations?.[animationName] ?? []).filter((texture): texture is Texture => Boolean(texture))
  }

  public get isDead(): boolean {
    return this.animationState === "dead"
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

  private findWallAtPoint(walls: Wall[], x: number, y: number): Wall | undefined {
    return walls.find(
      (wall) =>
        wall.container.visible &&
        // Полуоткрытый интервал [left, right): точка ровно на границе сетки
        // всегда принадлежит только одной клетке — той, что начинается в этой
        // точке, а не той, что в ней заканчивается.
        x >= wall.container.x &&
        x < wall.container.x + wall.width &&
        y >= wall.container.y &&
        y < wall.container.y + wall.height,
    )
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
