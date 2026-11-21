import { Module } from '@nestjs/common';
import { DbService } from './db/db.service';
import { HealthController } from './health/health.controller';
import { TasksController } from './tasks/tasks.controller';

@Module({
  controllers: [HealthController, TasksController],
  providers: [DbService],
})
export class AppModule {}
