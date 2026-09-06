import { Graphics } from "pixi.js"
import { Entity } from "./Entity"

/**
 * Лужа на уровне 3 (поверхность за травой) — препятствие прямо в линии
 * травы: муравей не может пройти сквозь неё, пока не наведёт мостик из
 * листа (см. GameScene.update — тратит один лист из carriedLeaves). Мостик,
 * в отличие от самого листа, наводится навсегда — bridged больше не
 * сбрасывается назад в false.
 *
 * Как и Wall, координаты — левый верхний угол (а не центр, как у Star/
 * Bubble): лужа встаёт в сетку вместо клетки травы, а не поверх неё.
 */
export class Puddle extends Entity {
  private bridged = false
  private water: Graphics
  private bridge: Graphics

  constructor(x: number, y: number, width: number, height: number) {
    super()
    this.container.x = x
    this.container.y = y
    this.width = width
    this.height = height

    this.water = new Graphics()
    this.water.beginFill(0x2f7fd1)
    this.water.drawRoundedRect(0, 0, width, height, height / 3)
    this.water.endFill()

    // Пара более светлых бликов — чтобы читалось как вода, а не просто
    // плоский синий прямоугольник.
    this.water.beginFill(0x6fb4ef, 0.5)
    this.water.drawEllipse(width * 0.3, height * 0.4, width * 0.16, height * 0.18)
    this.water.drawEllipse(width * 0.68, height * 0.55, width * 0.14, height * 0.16)
    this.water.endFill()

    this.container.addChild(this.water)

    // Мостик из наложенных листьев — скрыт, пока не вызван placeBridge().
    this.bridge = new Graphics()
    this.bridge.visible = false

    const leafCount = Math.max(3, Math.round(width / (height * 1.3)))
    for (let i = 0; i < leafCount; i++) {
      const lx = (width / leafCount) * (i + 0.5)
      this.bridge.beginFill(0x5cb85c)
      this.bridge.drawEllipse(lx, height / 2, width / leafCount / 1.6, height / 2.2)
      this.bridge.endFill()
    }

    this.container.addChild(this.bridge)
  }

  /** Наводит мостик поверх лужи — один раз, дальше проход через неё свободен навсегда. */
  public placeBridge(): void {
    if (this.bridged) return

    this.bridged = true
    this.water.alpha = 0.4
    this.bridge.visible = true
  }

  public get isBridged(): boolean {
    return this.bridged
  }

  public update(): void {
    // Лужа статична, логика обновления не нужна.
  }
}
