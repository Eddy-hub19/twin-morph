export class InputManager {
  private keys: Map<string, boolean> = new Map()
  private processedKeys: Set<string> = new Set()

  // Аналоговый вектор от сенсорного джойстика — в отличие от WASD (только 4
  // направления), тут можно двигаться под любым углом. x/y в диапазоне
  // [-1, 1], длина вектора — это "насколько сильно" отклонён стик (0..1).
  // Активен только пока палец реально держит стик — на клавиатуре (десктоп)
  // всегда null, поэтому джойстиковая логика её не затрагивает.
  private analogX = 0
  private analogY = 0
  private analogActive = false

  constructor() {
    window.addEventListener("keydown", this.onKeyDown)
    window.addEventListener("keyup", this.onKeyUp)
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.set(e.code, true)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.set(e.code, false)
    this.processedKeys.delete(e.code)
  }

  public isDown(keyCode: string): boolean {
    return this.keys.get(keyCode) ?? false
  }

  /**
   * Программно имитирует нажатие/отпускание клавиши — используется
   * сенсорными кнопками управления на мобильных экранах вместо реальной
   * клавиатуры.
   */
  public setKeyState(keyCode: string, isDown: boolean): void {
    this.keys.set(keyCode, isDown)
    if (!isDown) {
      this.processedKeys.delete(keyCode)
    }
  }

  /** Задаёт аналоговый вектор направления (сенсорный джойстик), x/y в [-1, 1]. */
  public setAnalogVector(x: number, y: number): void {
    this.analogX = x
    this.analogY = y
    this.analogActive = x !== 0 || y !== 0
  }

  /** Сбрасывает аналоговый вектор — стик отпущен. */
  public clearAnalogVector(): void {
    this.analogX = 0
    this.analogY = 0
    this.analogActive = false
  }

  /** Текущий аналоговый вектор джойстика, или null, если он сейчас не используется. */
  public getAnalogVector(): { x: number; y: number } | null {
    return this.analogActive ? { x: this.analogX, y: this.analogY } : null
  }

  public isJustPressed(keyCode: string): boolean {
    if (this.keys.get(keyCode) && !this.processedKeys.has(keyCode)) {
      this.processedKeys.add(keyCode)
      return true
    }
    return false
  }

  public destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown)
    window.removeEventListener("keyup", this.onKeyUp)
    this.keys.clear()
    this.processedKeys.clear()
  }
}
