import { Controller, Get } from "@nestjs/common"

/**
 * Обычные HTTP-эндпоинты (не Socket.IO) — по умолчанию у Nest-гейтвея нет
 * вообще никаких HTTP-маршрутов, кроме тех, что задекларированы явно, а
 * зайти на голый https://twin-morph.onrender.com/ (или дождаться дефолтного
 * health-check от Render, который стучится именно в "/") без контроллера —
 * получить 404. Нужны два адреса:
 *  1) "/" — корень: чтобы Render (по умолчанию проверяет живость именно
 *     здесь) и просто открытая в браузере ссылка видели "сервер жив", а не 404;
 *  2) "/health" — то же самое, но отдельным путём: именно его дёргает
 *     клиент перед подключением к WebSocket (см. game/network/serverHealth.ts —
 *     бесплатный план Render "засыпает" после простоя, первый запрос может
 *     занимать до минуты, а WebSocket-хендшейк для определения "жив ли
 *     сервер" плохо подходит — просто зависает без понятного прогресса).
 */
@Controller()
export class AppController {
  @Get()
  public getRoot(): { status: "ok"; message: string } {
    return { status: "ok", message: "Twin Morph server is running" }
  }

  @Get("health")
  public getHealth(): { status: "ok" } {
    return { status: "ok" }
  }
}
