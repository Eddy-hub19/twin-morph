import { Assets, Graphics, Sprite, Texture } from "pixi.js"
import { Entity } from "./Entity"
import { Star } from "./Star"
import { Wall, findWallAt } from "./Wall"
import type { EnemyNetState } from "../../shared/game-protocol"
import {
  ENEMY_SPEED,
  ENEMY_PROBE_DISTANCE as PROBE_DISTANCE,
  ENEMY_COMMIT_MIN as COMMIT_MIN,
  ENEMY_COMMIT_MAX as COMMIT_MAX,
  ENEMY_STAR_DETECT_RADIUS as STAR_DETECT_RADIUS,
  ENEMY_DIG_HIT_INTERVAL as DIG_HIT_INTERVAL,
  ENEMY_AREA_MARGIN,
  ENEMY_CARRY_SPEED_MULTIPLIER as CARRY_SPEED_MULTIPLIER,
  ENEMY_CARRY_COMMIT_MULTIPLIER as CARRY_COMMIT_MULTIPLIER,
  ENEMY_CARRY_MAX_TURN as CARRY_MAX_TURN,
} from "../config/GameConfig"

type StepResult = "moved" | "digging" | "blocked"

/**
 * Вражеский червяк. Держит курс (heading) некоторое время, не переигрывая
 * его каждый кадр, — раньше при погоне за звездой/домиком он каждый кадр
 * заново целился прямо на цель, и если путь был перекрыт, тут же дёргался в
 * случайную сторону, а на следующем кадре опять целился на цель — со стороны
 * это выглядело как дрожание/кручение на месте. Теперь: выбрали курс —
 * держимся его COMMIT_MIN..MAX секунд или пока не упрёмся в камень/границу.
 *
 * Непрокопанная земля/песок/руда на пути — не препятствие, а еда: как и
 * игрок, враг прогрызает её (руда — за несколько ударов), и продолжает
 * идти тем же курсом. Непроходимы только камень, бедрок (граница уровня) и
 * границы зоны — вот от них враг действительно уворачивается, выбирая
 * новый курс.
 */
export class EnemyWorm extends Entity {
  private sprite?: Sprite
  private carryIcon?: Graphics
  private speed = ENEMY_SPEED

  private heading = Math.random() * Math.PI * 2
  private commitTimer = 0

  private diggingWall?: Wall
  private digProgress = 0

  /** Звезда, которую враг сейчас тащит к домику (undefined — ничего не несёт). */
  public carriedStar?: Star

  /**
   * Короткая "неприкосновенность" после того, как игрок выбил украденную
   * звезду: не хватать её обратно тут же (иначе, пока игрок стоит рядом,
   * получается бесконечный цикл "украл-уронил" на одном месте).
   */
  public stealCooldown = 0

  /**
   * Co-op: пока `puppet` false — этот враг ведёт себя как обычно, честно
   * симулируя свой ИИ локально (так работает "хост" комнаты — первый по
   * RoomInfo.players — и всегда single player). Если true — update() ничего
   * не считает сам, а только отрисовывает состояние, присланное хостом (см.
   * setRemoteState/GameScene.applyEnemyNetState) — то есть ОДИН канонический
   * набор врагов на комнату, а не свой независимый у каждого клиента.
   */
  private puppet = false

  constructor(
    x: number,
    y: number,
    private areaTop: number,
    private areaHeight: number,
    private nestX: number,
    private nestY: number,
    /** Стабильный id ("enemy:0", "enemy:1", ...) — одинаковый у хоста и
     * гостя, раз оба спавнят врагов в одном порядке из общего seed. */
    public readonly remoteId: string,
  ) {
    super()
    this.container.x = x
    this.container.y = y
  }

  /** Гость применяет состояние, присланное хостом, вместо своего ИИ. */
  public setRemoteState(state: EnemyNetState): void {
    this.puppet = true
    this.container.x = state.x
    this.container.y = state.y
    this.container.rotation = state.rotation
    if (this.carryIcon) this.carryIcon.visible = Boolean(state.carryingStarId)
  }

  /** Хост собирает своё текущее состояние для рассылки гостю. carriedStar
   * передаётся отдельно (id), а не самим объектом Star — сети объекты не нужны. */
  public toNetState(carryingStarId: string | null): EnemyNetState {
    return {
      id: this.remoteId,
      kind: "enemy",
      x: this.container.x,
      y: this.container.y,
      rotation: this.container.rotation,
      alive: true,
      carryingStarId,
    }
  }

  public async init(): Promise<void> {
    if (this.sprite) {
      return
    }

    const texture = (Assets.get("/assets/enemy/enemy-worm.svg") as Texture | undefined) ?? (await Assets.load("/assets/enemy/enemy-worm.svg"))

    this.sprite = new Sprite(texture)
    this.sprite.anchor.set(0.5)

    this.width = this.sprite.width
    this.height = this.sprite.height

    this.container.addChild(this.sprite)

    // Маленькая звёздочка над спиной — видно, что враг что-то тащит.
    this.carryIcon = new Graphics()
    this.carryIcon.beginFill(0xffd700)
    this.carryIcon.drawCircle(0, -this.sprite.height / 2 - 5, 5)
    this.carryIcon.endFill()
    this.carryIcon.visible = false
    this.container.addChild(this.carryIcon)
  }

  public update(deltaTime: number, walls: Wall[] = [], stars: Star[] = []): void {
    if (!this.sprite) {
      return
    }

    // Гость комнаты не считает ИИ вообще — GameScene двигает эту сущность
    // напрямую через setRemoteState() каждый раз, когда приходит enemyState
    // от хоста (см. комментарий у puppet выше).
    if (this.puppet) {
      return
    }

    if (this.stealCooldown > 0) {
      this.stealCooldown = Math.max(0, this.stealCooldown - deltaTime)
    }

    if (this.carryIcon) {
      this.carryIcon.visible = Boolean(this.carriedStar)
      // Компенсируем поворот тела, чтобы иконка не крутилась вместе с ним.
      this.carryIcon.rotation = -this.container.rotation
    }

    this.commitTimer -= deltaTime

    const target = this.carriedStar ? { x: this.nestX, y: this.nestY } : this.findNearestStar(stars)

    if (this.commitTimer <= 0) {
      if (target) {
        const dx = target.x - this.container.x
        const dy = target.y - this.container.y

        if (Math.hypot(dx, dy) < 4) {
          this.commitTimer = COMMIT_MIN
          return
        }

        const targetAngle = Math.atan2(dy, dx)

        if (this.carriedStar) {
          // Тяжёлый груз — доворачивает только на ограниченный угол за раз.
          this.turnTowards(targetAngle, CARRY_MAX_TURN)
        } else {
          this.heading = targetAngle
        }
      } else {
        this.pickOpenHeading(walls)
      }

      const commitMin = this.carriedStar ? COMMIT_MIN * CARRY_COMMIT_MULTIPLIER : COMMIT_MIN
      const commitMax = this.carriedStar ? COMMIT_MAX * CARRY_COMMIT_MULTIPLIER : COMMIT_MAX
      this.commitTimer = commitMin + Math.random() * (commitMax - commitMin)
    }

    const result = this.step(walls, deltaTime)

    if (result === "blocked") {
      // Камень или край уровня — напролом не пройти. Ищем обходной курс и
      // держимся его (сбрасываем таймер), а не дёргаемся обратно к цели на
      // следующем же кадре — это и вызывало дрожание.
      if (this.pickOpenHeading(walls)) {
        this.commitTimer = COMMIT_MIN + Math.random() * (COMMIT_MAX - COMMIT_MIN)
      }
    }
  }

  /** Доворачивает heading к targetAngle не более чем на maxDelta радиан за раз. */
  private turnTowards(targetAngle: number, maxDelta: number): void {
    let diff = targetAngle - this.heading
    diff = Math.atan2(Math.sin(diff), Math.cos(diff))
    this.heading += Math.max(-maxDelta, Math.min(maxDelta, diff))
  }

  /** Ближайшая видимая ничья звезда в радиусе обнаружения (или undefined). */
  private findNearestStar(stars: Star[]): { x: number; y: number } | undefined {
    let best: Star | undefined
    let bestDistance = STAR_DETECT_RADIUS

    for (const star of stars) {
      if (!star.container.visible) {
        continue
      }

      const distance = Math.hypot(star.container.x - this.container.x, star.container.y - this.container.y)

      if (distance < bestDistance) {
        bestDistance = distance
        best = star
      }
    }

    return best ? { x: best.container.x, y: best.container.y } : undefined
  }

  /**
   * Один шаг вдоль текущего heading: свободно — идём, упёрлись в
   * непрокопанную землю/песок/руду — грызём её на месте, упёрлись в камень
   * или вышли за границу зоны уровня — сообщаем "blocked" (сами не
   * разворачиваемся, это решает вызывающий код).
   */
  private step(walls: Wall[], deltaTime: number): StepResult {
    const speed = this.carriedStar ? this.speed * CARRY_SPEED_MULTIPLIER : this.speed
    const distance = speed * deltaTime
    const nextX = this.container.x + Math.cos(this.heading) * distance
    const nextY = this.container.y + Math.sin(this.heading) * distance

    const margin = ENEMY_AREA_MARGIN
    const outOfBounds = nextY < this.areaTop + margin || nextY > this.areaTop + this.areaHeight - margin
    const obstacle = outOfBounds ? undefined : findWallAt(walls, nextX, nextY)

    if (outOfBounds || obstacle?.type === "stone" || obstacle?.type === "bedrock") {
      this.stopDigging()
      return "blocked"
    }

    if (obstacle) {
      this.digAt(obstacle, deltaTime)
      this.container.rotation = this.heading
      return "digging"
    }

    this.stopDigging()
    this.container.x = nextX
    this.container.y = nextY

    // Спрайт нарисован головой вправо — поворачиваем ровно по направлению
    // движения, получается плавный "бег" в любую сторону.
    this.container.rotation = this.heading
    return "moved"
  }

  /** Грызёт блок на месте раз в DIG_HIT_INTERVAL секунд, пока он не исчезнет. */
  private digAt(wall: Wall, deltaTime: number): void {
    if (this.diggingWall !== wall) {
      this.diggingWall = wall
      this.digProgress = 0
    }

    this.digProgress += deltaTime

    if (this.digProgress >= DIG_HIT_INTERVAL) {
      this.digProgress = 0
      wall.hit()
    }
  }

  private stopDigging(): void {
    this.diggingWall = undefined
    this.digProgress = 0
  }

  /** Занята ли точка камнем или бедроком (настоящее препятствие для щупов). */
  private isImpassable(walls: Wall[], x: number, y: number): boolean {
    const margin = ENEMY_AREA_MARGIN
    if (y < this.areaTop + margin || y > this.areaTop + this.areaHeight - margin) {
      return true
    }
    const type = findWallAt(walls, x, y)?.type
    return type === "stone" || type === "bedrock"
  }

  /**
   * Пробует короткие "щупы" в случайных направлениях вокруг текущей позиции
   * и выбирает первое, не упирающееся в камень/границу (земля не считается
   * препятствием — её всё равно можно прогрызть). Короткая дистанция щупа —
   * чтобы не выбрать курс, ведущий прямиком в камень через пару шагов.
   */
  private pickOpenHeading(walls: Wall[]): boolean {
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2
      const probeX = this.container.x + Math.cos(angle) * PROBE_DISTANCE
      const probeY = this.container.y + Math.sin(angle) * PROBE_DISTANCE

      if (!this.isImpassable(walls, probeX, probeY)) {
        this.heading = angle
        return true
      }
    }

    return false
  }
}
