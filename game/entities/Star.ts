import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { STAR_SIZE } from "../config/GameConfig"

export class Star extends Entity {
  // Круг нарисован вокруг локального (0,0) (см. drawCircle ниже) — то есть
  // container.x/y уже и так его ЦЕНТР, а не левый верхний угол. См.
  // комментарий у Worm.originX/Y — тот же принцип, тут просто не спрайт, а
  // Graphics.
  protected override originX = 0.5
  protected override originY = 0.5

  /** Стабильный id ("level:star:index") — одинаковый на обоих клиентах, раз
   * оба генерируют звёзды в одном и том же порядке из общего seed. По нему
   * сервер не даёт засчитать одну и ту же звезду дважды (см. GameScene). */
  public readonly id: string

  constructor(x: number, y: number, id: string) {
    super()
    this.id = id
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
