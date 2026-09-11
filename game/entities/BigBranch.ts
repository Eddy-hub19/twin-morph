import { Graphics } from "pixi.js"
import { Entity } from "./Entity"
import { ANT_SPEED, BIG_BRANCH_SOLO_SPEED_MULTIPLIER, BIG_BRANCH_DUO_SPEED_MULTIPLIER } from "../config/GameConfig"

/**
 * Велика гілка, яку треба дотягнути до останнього слота мосту через Pond.
 * Рухається лише вперед (startX -> targetX за progress 0..1) і ніколи не
 * відкочується назад, навіть якщо носії відпускають її чи тонуть — команда
 * просто продовжує з того самого місця пізніше (див. GameScene.update).
 *
 * Хост кімнати (або single player — там "хост" завжди сам собі) рахує
 * progress локально в tick(), гість лише малює те, що прийшло мережею — той
 * самий патерн, що й у EnemyWorm/GuardWorm (puppet/setRemoteState).
 */
export class BigBranch extends Entity {
  public installed = false
  public progress = 0

  private readonly startX: number
  private readonly targetX: number
  private puppet = false

  constructor(startX: number, targetX: number, y: number, width: number, height: number) {
    super()
    this.startX = startX
    this.targetX = targetX
    this.width = width
    this.height = height
    this.container.y = y
    this.container.x = startX

    const graphics = new Graphics()
    graphics.beginFill(0x6b4a2b)
    graphics.drawRoundedRect(0, 0, width, height, 5)
    graphics.endFill()
    graphics.lineStyle(2, 0x4a3218)
    graphics.moveTo(6, height / 2)
    graphics.lineTo(width - 6, height / 2)
    this.container.addChild(graphics)
  }

  /** Гость применяет присланный хостом прогресс вместо собственной симуляции. */
  public setRemoteState(progress: number): void {
    this.puppet = true
    this.applyProgress(progress)
  }

  /** Прежний хост вышел, и мы (бывший гость) стали новым хостом — тот же
   * приём, что и у EnemyWorm/GuardWorm.resumeLocalControl: подхватываем
   * симуляцию с ТЕКУЩЕГО (уже отрисованного) прогресса, без пересоздания. */
  public resumeLocalControl(): void {
    this.puppet = false
  }

  /**
   * Хост (или single player) продвигает ветку вперёд по числу одновременных
   * носителей (1 или 2 муравья, касающихся её и идущих в сторону пруда) —
   * скорость пропорциональна обычной скорости муравья (ANT_SPEED), чтобы
   * "тащить" выглядело сопоставимо с обычной ходьбой, а не отдельным
   * произвольным таймером.
   */
  public tick(deltaTime: number, carrierCount: number): void {
    if (this.puppet || this.installed || carrierCount <= 0) return

    const distance = Math.abs(this.targetX - this.startX) || 1
    const multiplier = carrierCount >= 2 ? BIG_BRANCH_DUO_SPEED_MULTIPLIER : BIG_BRANCH_SOLO_SPEED_MULTIPLIER
    const progressPerSecond = (ANT_SPEED * multiplier) / distance

    this.applyProgress(this.progress + progressPerSecond * deltaTime)
  }

  private applyProgress(progress: number): void {
    this.progress = Math.max(this.progress, Math.min(1, progress)) // никогда не откатываем назад
    this.container.x = this.startX + (this.targetX - this.startX) * this.progress
  }

  public markInstalled(): void {
    this.installed = true
  }

  public update(): void {
    // Вся логика — в tick()/applyProgress(), вызываемых из GameScene напрямую
    // (там же, где известно, кто сейчас касается ветки).
  }
}
