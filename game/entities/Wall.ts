import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { ORE_HIT_POINTS } from "../config/GameConfig"

// "bedrock" — граница уровня: не грызётся никем (ни игроком, ни врагами),
// но, в отличие от камня, не убивает при касании — это просто непроходимая
// стена-разделитель, а не опасность.
export type WallType = "dirt" | "stone" | "grass" | "sand" | "ore" | "bedrock"

export class Wall extends Entity {
  public type: WallType = "dirt"

  /** Сколько ударов ещё выдержит блок, прежде чем прогрызться насквозь. */
  public hitPoints: number
  /** Прочность блока в начале (для расчёта визуального прогресса). */
  public readonly maxHitPoints: number

  constructor(x: number, y: number, width: number, height: number, type: WallType = "dirt") {
    super()
    this.type = type
    this.container.x = x
    this.container.y = y
    this.width = width
    this.height = height

    this.maxHitPoints = type === "ore" ? ORE_HIT_POINTS : 1
    this.hitPoints = this.maxHitPoints

    if (type === "bedrock") {
      // Хорошо узнаваемая "предупреждающая лента" — тёмный фон с жёлтыми
      // диагональными полосами, ни с чем другим в игре не спутать: явно
      // читается как "сюда нельзя", а не просто ещё один тип земли.
      const bg = new Graphics()
      bg.beginFill(0x1c1c1c)
      bg.drawRect(0, 0, width, height)
      bg.endFill()
      this.container.addChild(bg)

      const stripes = new Graphics()
      stripes.beginFill(0xffc400)
      const stripeWidth = width * 0.35
      const step = stripeWidth * 2
      for (let offset = -height; offset < width + height; offset += step) {
        stripes.moveTo(offset, 0)
        stripes.lineTo(offset + stripeWidth, 0)
        stripes.lineTo(offset + stripeWidth - height, height)
        stripes.lineTo(offset - height, height)
        stripes.closePath()
      }
      stripes.endFill()

      const clip = new Graphics()
      clip.beginFill(0xffffff)
      clip.drawRect(0, 0, width, height)
      clip.endFill()

      stripes.mask = clip
      this.container.addChild(clip)
      this.container.addChild(stripes)

      return
    }

    const graphics = new Graphics()

    const color =
      type === "stone"
        ? 0x37474f
        : type === "grass"
          ? 0x4caf50
          : type === "sand"
            ? 0xd2b48c
            : type === "ore"
              ? 0xc9a227
              : 0x4e3629

    graphics.beginFill(color)
    graphics.drawRect(0, 0, width, height)
    graphics.endFill()

    this.container.addChild(graphics)
  }

  /**
   * Наносит один удар по блоку (кроме камня и бедрока — камень не грызётся,
   * а убивает, бедрок вообще неразрушим). "Руда" выдерживает несколько
   * ударов, обычная земля/песок — один. Возвращает true, если блок полностью
   * прогрызен и должен исчезнуть.
   */
  public hit(): boolean {
    if (this.type === "bedrock") {
      return false
    }

    this.hitPoints = Math.max(this.hitPoints - 1, 0)

    if (this.hitPoints <= 0) {
      this.container.visible = false
      return true
    }

    // Чем меньше прочности осталось, тем светлее выглядит блок — виден
    // прогресс прогрызания у многоударных блоков.
    this.container.alpha = 0.35 + 0.65 * (this.hitPoints / this.maxHitPoints)
    return false
  }

  public update(): void {}
}

/**
 * Видимая (ещё не прогрызенная) стена, в которую попадает точка (x, y), —
 * или undefined, если там туннель.
 */
export function findWallAt(walls: Wall[], x: number, y: number): Wall | undefined {
  return walls.find(
    (wall) =>
      wall.container.visible &&
      x >= wall.container.x &&
      x < wall.container.x + wall.width &&
      y >= wall.container.y &&
      y < wall.container.y + wall.height,
  )
}

/**
 * true, если точка (x, y) попадает внутрь видимой (ещё не прогрызенной)
 * стены — то есть это "твёрдая земля", а не туннель. Используется, чтобы
 * не пускать вражеских червяков сквозь непрокопанные блоки.
 */
export function isPointBlocked(walls: Wall[], x: number, y: number): boolean {
  return findWallAt(walls, x, y) !== undefined
}
