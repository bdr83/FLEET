import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // Browsers only (the driver app's web preview); the mobile apps and the dashboard BFF do not need CORS.
  const origins = process.env.CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins?.length) app.enableCors({ origin: origins, allowedHeaders: ['authorization', 'content-type'], maxAge: 600 });
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
