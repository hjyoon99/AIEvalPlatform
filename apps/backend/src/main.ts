import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Nest 애플리케이션을 구성하고 지정된 포트에서 HTTP 서버를 시작한다.
 * @returns 서버 시작이 완료되면 이행되는 Promise
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: [
      process.env.DASHBOARD_URL ?? 'http://localhost:5173',
      'http://127.0.0.1:5173',
    ],
  });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
