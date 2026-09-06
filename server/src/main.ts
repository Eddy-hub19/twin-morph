import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module"

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)

  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000"
  app.enableCors({
    origin: frontendUrl,
    credentials: true,
  })

  // 0.0.0.0, а не localhost по умолчанию — Render (и большинство PaaS)
  // проксируют трафик на контейнер извне, слушать только loopback-адрес
  // там означает быть недоступным снаружи вообще.
  const port = process.env.PORT || 3001
  await app.listen(port, "0.0.0.0")

  // eslint-disable-next-line no-console
  console.log(`[twin-morph-server] listening on :${port} (frontend origin: ${frontendUrl})`)
}

bootstrap()
