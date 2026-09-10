import { Assets, Sprite, Texture } from "pixi.js"
import { Entity } from "./Entity"
import { Wall, findWallAt } from "./Wall"
import type { EnemyNetState } from "../../shared/game-protocol"
import {
  GUARD_PATROL_SPEED as PATROL_SPEED,
  GUARD_ALERT_SPEED as ALERT_SPEED,
  GUARD_DETECT_RADIUS as DETECT_RADIUS,
  GUARD_LOSE_RADIUS as LOSE_RADIUS,
  GUARD_PATROL_REACH as PATROL_REACH,
  GUARD_AREA_MARGIN,
  GUARD_DESIRED_WIDTH,
} from "../config/GameConfig"

/**
 * Страж — патрулирует у входа в нору вражеских червяков-воров, перекрывая
 * проход. В отличие от воров, сам не роет землю и никого не грабит: упёрся
 * в стену тоннеля — разворачивается назад, как и полагается патрулю.
 *
 * Реагирует ТОЛЬКО на игрока: замечает его в радиусе обнаружения и вместо
 * патруля идёт прямо на него, физически блокируя проход при столкновении
 * (см. GameScene — там же обработка блокировки). Вражеских воров страж
 * вообще не замечает и не считает препятствием — пока он занят погоней за
 * игроком в одном тоннеле, вор спокойно проскакивает мимо по другому пути.
 */
export class GuardWorm extends Entity {
  private sprite?: Sprite
  private speed = PATROL_SPEED
  private heading = 0
  private alert = false

  private readonly patrolAX: number
  private readonly patrolAY: number
  private readonly patrolBX: number
  private readonly patrolBY: number
  private towardB = true

  /** Co-op: гость только отрисовывает состояние от хоста, см. EnemyWorm.puppet. */
  private puppet = false

  constructor(
    x: number,
    y: number,
    private areaTop: number,
    private areaHeight: number,
    /** Стабильный id ("guard:0") — страж один на уровень, но id всё равно
     * через тот же механизм, что и обычные враги. */
    public readonly remoteId: string = "guard:0",
  ) {
    super()
    this.container.x = x
    this.container.y = y

    // Патрулирует небольшой отрезок вокруг точки спавна — как раз
    // перекрывая проход в тоннеле у норы.
    this.patrolAX = x - PATROL_REACH
    this.patrolAY = y
    this.patrolBX = x + PATROL_REACH
    this.patrolBY = y
  }

  /** Гость применяет состояние, присланное хостом, вместо своего ИИ. */
  public setRemoteState(state: EnemyNetState): void {
    this.puppet = true
    this.container.x = state.x
    this.container.y = state.y
    this.container.rotation = state.rotation
  }

  public toNetState(): EnemyNetState {
    return {
      id: this.remoteId,
      kind: "guard",
      x: this.container.x,
      y: this.container.y,
      rotation: this.container.rotation,
      alive: true,
      carryingStarId: null,
    }
  }

  public async init(): Promise<void> {
    if (this.sprite) {
      return
    }

    const texture = (Assets.get("/assets/enemy/enemy-worm.svg") as Texture | undefined) ?? (await Assets.load("/assets/enemy/enemy-worm.svg"))

    this.sprite = new Sprite(texture)
    this.sprite.anchor.set(0.5)
    // Красноватый оттенок — визуально отличает стража от обычных воров.
    this.sprite.tint = 0xff8a6a

    // Текстура вдвое шире клетки сетки — без масштаба страж торчал бы из
    // прокопанного туннеля в обе стены сразу. Коллайдер (width/height)
    // считаем ИЗ уже применённого масштаба, а не из сырых размеров текстуры,
    // иначе видимый размер и зона столкновения разойдутся.
    const scale = GUARD_DESIRED_WIDTH / this.sprite.texture.width
    this.sprite.scale.set(scale)

    this.width = this.sprite.width
    this.height = this.sprite.height

    this.container.addChild(this.sprite)
  }

  /**
   * Страж не участвует в обычном общем цикле update() всех сущностей (там
   * сигнатура — deltaTime/walls/stars, а стражу нужна именно позиция
   * игрока, а не список звёзд) — GameScene вызывает tick() отдельно, только
   * для стражей, передавая позицию игрока напрямую.
   */
  public update(): void {
    // Не используется: логика стража — в tick(), вызываемом GameScene явно.
  }

  /**
   * @param playerX,playerY — позиция игрока (undefined, если игрока сейчас
   * нет в игре — например, во время метаморфозы). Страж реагирует только на
   * неё, вражеских воров ему вообще не передают.
   */
  public tick(deltaTime: number, walls: Wall[] = [], playerX?: number, playerY?: number): void {
    if (!this.sprite) {
      return
    }

    // Гость комнаты не считает патруль/погоню сам — двигается через
    // setRemoteState() по данным хоста (см. комментарий у puppet выше).
    if (this.puppet) {
      return
    }

    const hasPlayer = playerX !== undefined && playerY !== undefined

    if (hasPlayer) {
      const distance = Math.hypot(playerX! - this.container.x, playerY! - this.container.y)

      if (!this.alert && distance < DETECT_RADIUS) {
        this.alert = true
      } else if (this.alert && distance > LOSE_RADIUS) {
        this.alert = false
      }
    } else {
      this.alert = false
    }

    let targetX: number
    let targetY: number

    if (this.alert && hasPlayer) {
      targetX = playerX!
      targetY = playerY!
      this.speed = ALERT_SPEED
    } else {
      targetX = this.towardB ? this.patrolBX : this.patrolAX
      targetY = this.towardB ? this.patrolBY : this.patrolAY
      this.speed = PATROL_SPEED
    }

    const dx = targetX - this.container.x
    const dy = targetY - this.container.y

    if (!this.alert && Math.hypot(dx, dy) < 6) {
      // Дошли до края патрульного отрезка — разворачиваемся.
      this.towardB = !this.towardB
      return
    }

    this.heading = Math.atan2(dy, dx)

    const step = this.speed * deltaTime
    const nextX = this.container.x + Math.cos(this.heading) * step
    const nextY = this.container.y + Math.sin(this.heading) * step

    const margin = GUARD_AREA_MARGIN
    const outOfBounds = nextY < this.areaTop + margin || nextY > this.areaTop + this.areaHeight - margin
    const blocked = outOfBounds || Boolean(findWallAt(walls, nextX, nextY))

    if (blocked) {
      // Страж не роет — любая непрокопанная стена для него непроходима.
      // Разворачиваем патруль в другую сторону; в погоне за игроком просто
      // стоим и ждём, пока путь не откроется (игрок сам его прокопает).
      if (!this.alert) {
        this.towardB = !this.towardB
      }
      return
    }

    this.container.x = nextX
    this.container.y = nextY
    this.container.rotation = this.heading
  }
}
