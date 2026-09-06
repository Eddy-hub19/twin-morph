import { Application } from "pixi.js"
import { InputManager } from "../input/InputManager"
import { Scene } from "../scenes/Scene"

export class SceneManager {
  private currentScene: Scene | null = null

  constructor(
    private app: Application,
    private input: InputManager,
  ) {}

  public change(scene: Scene): void {
    if (this.currentScene) {
      this.app.stage.removeChild(this.currentScene.container)
      this.currentScene.destroy()
    }

    this.currentScene = scene
    this.currentScene.init(this.app, this.input)
  }

  public update(deltaTime: number): void {
    this.currentScene?.update(deltaTime)
  }
}
