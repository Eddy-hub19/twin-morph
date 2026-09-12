import { Graphics } from "pixi.js"
import { Entity } from "./Entity"

/**
 * Подводный проход у самого дна уровня 3 (вертикальный водоём) — заперт, пока
 * ключ не найден (см. GameScene.update, ветка level === 3): визуально просто
 * тёмная запертая ниша, коснуться которой ни к чему не приводит. Как только
 * ключ подобран (в co-op — кем угодно из комнаты), open() навсегда переводит
 * его в открытое состояние — касание им запускает метаморфозу обратно в
 * червя и переход на уровень 4 (см. GameScene.handleMetamorphosis).
 *
 * Координаты — левый верхний угол (как у Pond/BridgeSlot), не центр.
 */
export class SubmergedPassage extends Entity {
  public readonly id: string
  private isOpen = false
  private graphics: Graphics

  constructor(x: number, y: number, width: number, height: number, id: string) {
    super()
    this.id = id
    this.container.x = x
    this.container.y = y
    this.width = width
    this.height = height

    this.graphics = new Graphics()
    this.container.addChild(this.graphics)
    this.draw()
  }

  private draw(): void {
    this.graphics.clear()

    if (this.isOpen) {
      this.graphics.beginFill(0x0c2f42, 0.4)
      this.graphics.drawRoundedRect(0, 0, this.width, this.height, 12)
      this.graphics.endFill()
      this.graphics.lineStyle(3, 0xffd700, 0.9)
      this.graphics.drawRoundedRect(3, 3, this.width - 6, this.height - 6, 10)
    } else {
      this.graphics.beginFill(0x0c2f42, 0.85)
      this.graphics.drawRoundedRect(0, 0, this.width, this.height, 12)
      this.graphics.endFill()
      this.graphics.lineStyle(3, 0x2a1f14, 0.9)
      this.graphics.drawRoundedRect(3, 3, this.width - 6, this.height - 6, 10)
      // Замочная скважина — единственный явный намёк, что тут нужен ключ.
      this.graphics.beginFill(0x2a1f14, 0.9)
      this.graphics.drawCircle(this.width / 2, this.height / 2 - 4, 6)
      this.graphics.drawRect(this.width / 2 - 3, this.height / 2 - 2, 6, 12)
      this.graphics.endFill()
    }
  }

  /** Навсегда открывает проход (ключ найден) — идемпотентно. */
  public open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.draw()
  }

  public get isUnlocked(): boolean {
    return this.isOpen
  }

  public update(): void {
    // Проход статичен, логика обновления не нужна.
  }
}
