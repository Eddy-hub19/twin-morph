import { Graphics, Text, TextStyle } from "pixi.js"
import { Entity } from "./Entity"
import { NEST_WIDTH, NEST_HEIGHT } from "../config/GameConfig"

/**
 * Домик вражеских червяков — шалаш из скрещенных палок. Сюда они тащат
 * украденные звёзды: звёзды не исчезают насовсем, а складываются кучкой
 * прямо тут (см. GameScene) — игрок может прийти и забрать их обратно.
 * Над шалашом висит счётчик, сколько звёзд сейчас в куче.
 */
export class Nest extends Entity {
  private countText: Text

  constructor(x: number, y: number) {
    super()
    this.container.x = x
    this.container.y = y

    this.width = NEST_WIDTH
    this.height = NEST_HEIGHT

    const graphics = new Graphics()

    // Куча веток у основания
    graphics.beginFill(0x6b4a2b)
    graphics.drawEllipse(0, 15, 23, 8)
    graphics.endFill()

    // Скрещенные палки шалашом
    graphics.lineStyle(4, 0x8a6238)
    graphics.moveTo(-20, 18)
    graphics.lineTo(3, -19)
    graphics.moveTo(20, 18)
    graphics.lineTo(-3, -19)
    graphics.moveTo(-13, 18)
    graphics.lineTo(11, -15)
    graphics.moveTo(13, 18)
    graphics.lineTo(-11, -15)

    this.container.addChild(graphics)

    this.countText = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: "sans-serif",
        fontSize: 14,
        fontWeight: "bold",
        fill: 0xffd700,
        stroke: { color: 0x1a110b, width: 3 },
      }),
    })
    this.countText.anchor.set(0.5, 1)
    this.countText.position.set(0, -20)
    this.container.addChild(this.countText)
  }

  /** Показывает текущее число звёзд, лежащих в куче у домика (0 — прячет подпись). */
  public setStoredCount(count: number): void {
    this.countText.text = count > 0 ? `⭐×${count}` : ""
  }

  public update(): void {}
}
