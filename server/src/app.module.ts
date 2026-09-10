import { Module } from "@nestjs/common"
import { GameModule } from "./game/game.module"
import { AppController } from "./app.controller"

@Module({
  imports: [GameModule],
  controllers: [AppController],
})
export class AppModule {}
