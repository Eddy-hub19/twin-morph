import { Container } from "pixi.js"

export abstract class Entity {
  public container = new Container()
  public width: number = 0
  public height: number = 0

  public abstract update(deltaTime: number, walls?: any[], stars?: any[]): void

  public getBounds() {
    return {
      x: this.container.x,
      y: this.container.y,
      width: this.width,
      height: this.height,
    }
  }

  public isColliding(other: Entity): boolean {
    const a = this.getBounds()
    const b = other.getBounds()
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  }

  public destroy(): void {
    this.container.destroy({ children: true })
  }
}
