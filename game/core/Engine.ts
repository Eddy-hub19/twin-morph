import { Application } from "pixi.js"
import { Time } from "./Time"
import { Scene } from "../scenes/Scene"
import { GameScene } from "../scenes/GameScene"
import { InputManager } from "../input/InputManager"
import { AssetLoader } from "../assets/AssetLoader"

export class Engine {
  private app: Application | null = null
  private readonly time = new Time()
  private scene: Scene | null = null
  public readonly input = new InputManager()

  constructor(private container: HTMLDivElement) {}

  public async initialize(): Promise<void> {
    this.app = new Application()

    await this.app.init({
      resizeTo: this.container,
      background: "0x1A110B",
      antialias: true,
    })

    await AssetLoader.load()

    this.scene = new GameScene()
    this.scene.init(this.app, this.input)

    this.app.ticker.add(this.update)
    this.container.appendChild(this.app.canvas)
  }

  private update = (): void => {
    if (!this.app) return

    this.time.update(this.app.ticker.deltaMS)
    this.scene?.update(this.time.deltaTime)
  }
}
