export class Time {
  public deltaTime = 0
  public elapsedTime = 0

  update(deltaMS: number): void {
    this.deltaTime = deltaMS / 1000
    this.elapsedTime += this.deltaTime
  }
}
