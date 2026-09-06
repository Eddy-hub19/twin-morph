import { Assets } from "pixi.js"

const wormAnimationAssets = [
  "/assets/worm/idle/idle.json",
  "/assets/worm/walk/walk.json",
  "/assets/worm/dead/dead.json",
]

const ANT_WALK_FRAME_COUNT = 8
const ANT_DEAD_FRAME_COUNT = 6
const antAnimationAssets = [
  ...Array.from({ length: ANT_WALK_FRAME_COUNT }, (_, i) => `/assets/ant/walk-flat/frame-${i}.svg`),
  ...Array.from({ length: ANT_DEAD_FRAME_COUNT }, (_, i) => `/assets/ant/dead-flat/frame-${i}.svg`),
  "/assets/ant/leaf.svg",
]

export class AssetLoader {
  public static async load(): Promise<void> {
    await Assets.load([...wormAnimationAssets, ...antAnimationAssets])
    console.log("Worm assets loaded")
    console.log("Ant assets loaded")
  }
}
