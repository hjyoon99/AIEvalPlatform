import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

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
