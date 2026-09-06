import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { SKY_COLOR, CLOUD_COLOR, CLOUD_COUNT } from "../config/GameConfig"

/**
 * Небо над травой — раньше эта область была просто пустым пространством
 * (никакой стены/спрайта там не рисуется, чтобы не мешать муравью), из-за
 * чего сквозь неё был виден чёрный фон страницы. Чисто декоративный задник:
 * голубой прямоугольник во всю область неба сегмента плюс несколько облаков,
 * без какой-либо логики или столкновений — с игроком/сущностями никогда не
 * взаимодействует.
 *
 * Координаты — левый верхний угол области неба (как у Wall), а не центр.
 */
export class Sky extends Entity {
  constructor(x: number, y: number, width: number, height: number) {
    super()
    this.container.x = x
    this.container.y = y
    this.width = width
    this.height = height

    const bg = new Graphics()
    bg.beginFill(SKY_COLOR)
    bg.drawRect(0, 0, width, height)
    bg.endFill()
    this.container.addChild(bg)

    const drawCloud = (cx: number, cy: number, scale: number) => {
      const cloud = new Graphics()
      cloud.beginFill(CLOUD_COLOR, 0.9)
      cloud.drawEllipse(0, 0, 34 * scale, 16 * scale)
      cloud.drawEllipse(-22 * scale, 4 * scale, 20 * scale, 13 * scale)
      cloud.drawEllipse(22 * scale, 4 * scale, 22 * scale, 13 * scale)
      cloud.endFill()
      cloud.position.set(cx, cy)
      this.container.addChild(cloud)
    }

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const cx = Math.random() * width
      const cy = height * (0.15 + Math.random() * 0.5)
      const scale = 0.7 + Math.random() * 0.8
      drawCloud(cx, cy, scale)
    }
  }

  public update(): void {
    // Небо статично, логика обновления не нужна.
  }
}
