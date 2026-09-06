import { Application, Container } from "pixi.js"
import { InputManager } from "../input/InputManager"

export abstract class Scene {
  public readonly container = new Container()
  protected app!: Application
  protected input!: InputManager

  public init(app: Application, input: InputManager): void {
    this.app = app
    this.input = input

    this.app.stage.addChild(this.container)
    this.onCreate()
  }

  protected abstract onCreate(): void
  public abstract update(deltaTime: number): void

  public destroy(): void {
    this.onDestroy()
    this.container.destroy({ children: true })
  }

  protected onDestroy(): void {}
}
