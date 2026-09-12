import { Assets, Sprite, Texture } from "pixi.js"
import { Entity } from "./Entity"
import { findWallAt, type WallLookup } from "./Wall"
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

/** Позиция одного игрока-кандидата на цель стража — id нужен только для
 * хранения "текущей цели" между кадрами (см. currentTargetId), сама позиция
 * не привязана к конкретному классу (Worm/Ant), лишь бы было x/y. */
export interface GuardTarget {
  id: string
  x: number
  y: number
}

/**
 * Страж — патрулирует у входа в нору вражеских червяков-воров, перекрывая
 * проход. В отличие от воров, сам не роет землю и никого не грабит: упёрся
 * в стену тоннеля — разворачивается назад, как и полагается патрулю.
 *
 * Реагирует на ЛЮБОГО игрока в комнате (в co-op — обоих сразу, см.
 * GameScene.getGuardTargets): замечает ближайшего в радиусе обнаружения и
 * вместо патруля идёт прямо на него, физически блокируя проход при
 * столкновении (см. GameScene — там же обработка блокировки). Вражеских
 * воров страж вообще не замечает и не считает препятствием — пока он занят
 * погоней за игроком в одном тоннеле, вор спокойно проскакивает мимо по
 * другому пути.
 */
export class GuardWorm extends Entity {
  private sprite?: Sprite
  private speed = PATROL_SPEED
  private heading = 0
  private alert = false

  /** id текущей цели погони (GuardTarget.id) — null, пока страж патрулирует.
   * Хранится между кадрами специально ради гистерезиса переключения: без
   * него страж перецеливался бы на ближайшего игрока каждый кадр и дрожал
   * бы между двумя игроками на почти одинаковом расстоянии. */
  private currentTargetId: string | null = null
  /** Секунды до следующего разрешённого переключения цели — см. tick(). */
  private targetSwitchCooldown = 0
  /** Другой игрок должен быть ближе текущей цели минимум на этот запас (px),
   * иначе цель не меняется — небольшая "гистерезисная зона" вокруг равного
   * расстояния, чтобы не дёргаться при почти одинаковой дистанции. */
  private static readonly TARGET_SWITCH_MARGIN = 24
  /** Не чаще раза в столько секунд разрешаем реальное переключение цели. */
  private static readonly TARGET_SWITCH_COOLDOWN = 0.5

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

  /** Хост комнаты вышел, и мы (бывший гость) стали новым хостом — подхватываем
   * патруль/погоню с ТЕКУЩЕЙ (уже отрисованной) позиции, без пересоздания
   * сущности и без дублирования (см. EnemyWorm.resumeLocalControl — тот же
   * приём). Цель погони сбрасываем: старый alert/currentTargetId нам не
   * принадлежал, честнее заново оценить обстановку на следующем тике. */
  public resumeLocalControl(): void {
    this.puppet = false
    this.alert = false
    this.currentTargetId = null
    this.targetSwitchCooldown = 0
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
   * @param players — позиции ВСЕХ игроков комнаты сейчас в игре (в single
   * player — один, в co-op — оба; пустой массив, если игрока сейчас нет,
   * например во время метаморфозы). Страж реагирует на ближайшего из них в
   * своей зоне агрессии и переслеживает его, переключаясь на другого игрока,
   * только если текущая цель вышла из радиуса погони или другой игрок стал
   * заметно (TARGET_SWITCH_MARGIN) ближе — и не чаще, чем раз в
   * TARGET_SWITCH_COOLDOWN секунд, иначе при равной дистанции цель дрожала
   * бы между игроками каждый кадр. Вражеских воров стражу вообще не передают.
   */
  public tick(deltaTime: number, wallLookup: WallLookup, players: GuardTarget[] = []): void {
    if (!this.sprite) {
      return
    }

    // Гость комнаты не считает патруль/погоню сам — двигается через
    // setRemoteState() по данным хоста (см. комментарий у puppet выше).
    if (this.puppet) {
      return
    }

    this.targetSwitchCooldown = Math.max(0, this.targetSwitchCooldown - deltaTime)

    let nearest: (GuardTarget & { distance: number }) | undefined
    let current: (GuardTarget & { distance: number }) | undefined

    for (const player of players) {
      const distance = Math.hypot(player.x - this.container.x, player.y - this.container.y)
      if (!nearest || distance < nearest.distance) nearest = { ...player, distance }
      if (player.id === this.currentTargetId) current = { ...player, distance }
    }

    if (this.alert) {
      if (!current || current.distance > LOSE_RADIUS) {
        // Текущая цель отошла за радиус погони (или вовсе пропала) —
        // переключаемся на ближайшего из оставшихся, если он ещё в радиусе;
        // иначе погоня закончена, возвращаемся к патрулю.
        if (nearest && nearest.distance <= LOSE_RADIUS) {
          this.currentTargetId = nearest.id
          current = nearest
        } else {
          this.alert = false
          this.currentTargetId = null
          current = undefined
        }
      } else if (
        nearest &&
        nearest.id !== current.id &&
        nearest.distance + GuardWorm.TARGET_SWITCH_MARGIN < current.distance &&
        this.targetSwitchCooldown <= 0
      ) {
        // Другой игрок заметно (не "почти так же") ближе — переключаемся, но
        // не чаще раза в TARGET_SWITCH_COOLDOWN.
        this.currentTargetId = nearest.id
        this.targetSwitchCooldown = GuardWorm.TARGET_SWITCH_COOLDOWN
        current = nearest
      }
    } else if (nearest && nearest.distance < DETECT_RADIUS) {
      this.alert = true
      this.currentTargetId = nearest.id
      this.targetSwitchCooldown = GuardWorm.TARGET_SWITCH_COOLDOWN
      current = nearest
    }

    let targetX: number
    let targetY: number

    if (this.alert && current) {
      targetX = current.x
      targetY = current.y
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
    const blocked = outOfBounds || Boolean(findWallAt(wallLookup, nextX, nextY))

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
