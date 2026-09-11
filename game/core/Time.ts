/** Максимальный шаг deltaTime, секунды — защита от одного огромного скачка
 * после паузы/сворачивания вкладки (мобильный Safari особенно агрессивно
 * тормозит rAF в фоновой вкладке и потом отдаёт один большой deltaMS на
 * возврате). Без клампа сущности (Worm/Ant/Frog/враги), умножающие deltaTime
 * напрямую на скорость, могли бы за один кадр проскочить сквозь стену/
 * коллизию. 1/15с — заметно больше обычного кадра (~1/60с), но достаточно
 * мало, чтобы не ломать физику. */
const MAX_DELTA_SECONDS = 1 / 15

/** Сколько последних кадров учитывается в скользящем среднем FPS (см. getFps) —
 * сглаживает шум отдельных кадров, не будучи слишком инертным. */
const FPS_SAMPLE_SIZE = 30

export class Time {
  public deltaTime = 0
  public elapsedTime = 0

  private fpsSamples: number[] = []
  private fpsSampleSum = 0

  update(deltaMS: number): void {
    this.deltaTime = Math.min(deltaMS / 1000, MAX_DELTA_SECONDS)
    this.elapsedTime += this.deltaTime

    // Скользящее среднее по НЕклампованному deltaMS — иначе счётчик FPS сам
    // соврал бы (показывал не больше 15), когда клампится реальный лаг.
    const instantFps = deltaMS > 0 ? 1000 / deltaMS : 0
    this.fpsSamples.push(instantFps)
    this.fpsSampleSum += instantFps
    if (this.fpsSamples.length > FPS_SAMPLE_SIZE) {
      this.fpsSampleSum -= this.fpsSamples.shift()!
    }
  }

  /** Сглаженный FPS за последние FPS_SAMPLE_SIZE кадров — только для
   * временного dev-индикатора (см. Engine/Game.tsx), не участвует в логике. */
  public getFps(): number {
    return this.fpsSamples.length > 0 ? this.fpsSampleSum / this.fpsSamples.length : 0
  }
}
