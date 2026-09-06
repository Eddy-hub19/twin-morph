import "reflect-metadata"
import { NestFactory } from "@nestjs/core"
import { AppModule } from "./app.module"

async function bootstrap(): Promise<void> {
  const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:3000"

  const app = await NestFactory.create(AppModule, {
    cors: { origin: clientOrigin, credentials: true },
  })

  const port = Number(process.env.PORT ?? 3001)
  await app.listen(port)

  // eslint-disable-next-line no-console
  console.log(`[twin-morph-server] listening on :${port} (client origin: ${clientOrigin})`)
}

bootstrap()
