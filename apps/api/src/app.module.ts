import { Module } from '@nestjs/common';
import { DbService } from './db/db.service';
import { HealthController } from './health/health.controller';
import { TasksController } from './tasks/tasks.controller';
import { AuthController } from './auth/auth.controller';
import { OtpService, LogSmsSender, SMS_SENDER } from './auth/otp.service';
import { SessionService } from './auth/session.service';
import { AuthGuard } from './auth/auth.guard';
import { TenantsController } from './tenants/tenants.controller';
import { MembersController } from './members/members.controller';
import { OrgController } from './org/org.controller';

@Module({
  controllers: [HealthController, AuthController, TenantsController, MembersController, OrgController, TasksController],
  providers: [
    DbService,
    OtpService,
    SessionService,
    AuthGuard,
    { provide: SMS_SENDER, useClass: LogSmsSender },
  ],
})
export class AppModule {}
