import { Graphics, Text, TextStyle } from "pixi.js"
import { Entity } from "./Entity"

/**
 * Декоративный маркер прохода наверх, на следующий уровень — стоит прямо
 * над узким дверным проёмом в потолке уровня 0 (единственное открытое
 * место, остальной потолок теперь закрыт обычной стеной, см. GameScene).
 * Чисто визуальный ориентир, ни с чем не сталкивается.
 */
export class LevelDoorMarker extends Entity {
  constructor(centerX: number, y: number, label: string) {
    super()
    this.container.x = centerX
    this.container.y = y

    const glow = new Graphics()
    glow.beginFill(0x66bb6a, 0.28)
    glow.drawCircle(0, 0, 46)
    glow.endFill()
    this.container.addChild(glow)

    const text = new Text({
      text: label,
      style: new TextStyle({
        fontFamily: "sans-serif",
        fontSize: 15,
        fontWeight: "bold",
        fill: 0x81c784,
        stroke: { color: 0x1a110b, width: 4 },
        align: "center",
      }),
    })
    text.anchor.set(0.5)
    this.container.addChild(text)
  }

  public update(): void {}
}
