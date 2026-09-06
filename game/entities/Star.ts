import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { STAR_SIZE } from "../config/GameConfig"

export class Star extends Entity {
  constructor(x: number, y: number) {
    super()
    this.container.x = x
    this.container.y = y

    this.width = STAR_SIZE
    this.height = STAR_SIZE

    const graphics = new Graphics()
    graphics.beginFill(0xffd700)
    graphics.drawCircle(0, 0, STAR_SIZE / 2)
    graphics.endFill()

    this.container.addChild(graphics)
  }

  public update(): void {
    // Звезда не требует логики обновления в текущем сценарии.
  }
}
