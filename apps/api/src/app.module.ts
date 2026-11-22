import { Module } from '@nestjs/common';
import { DbService } from './db/db.service';
import { HealthController } from './health/health.controller';
import { TasksController } from './tasks/tasks.controller';
import { AuthController } from './auth/auth.controller';
import { OtpService, SMS_SENDER } from './auth/otp.service';
import { smsSenderFromEnv } from './auth/sms';
import { SessionService } from './auth/session.service';
import { AuthGuard } from './auth/auth.guard';
import { TenantsController } from './tenants/tenants.controller';
import { MembersController } from './members/members.controller';
import { OrgController } from './org/org.controller';
import { AssetsController } from './fleet/assets.controller';
import { WorkersController } from './fleet/workers.controller';
import { DocumentsController } from './fleet/documents.controller';
import { DriverController } from './driver/driver.controller';
import { DispatchController } from './dispatch/dispatch.controller';
import { TrackingController } from './tracking/tracking.controller';
import { ReportsController } from './reports/reports.controller';
import { CustomersController } from './crm/customers.controller';
import { ContractsController } from './crm/contracts.controller';
import { PortalController } from './crm/portal.controller';
import { MaintenanceController } from './maint/maintenance.controller';
import { ExpensesController } from './maint/expenses.controller';
import { InvoicesController } from './billing/invoices.controller';
import { PaymentsController } from './billing/payments.controller';
import { DeliveryController } from './sectors/delivery/delivery.controller';
import { ConcreteController } from './sectors/concrete/concrete.controller';
import { StaffingController } from './sectors/staffing/staffing.controller';
import { InternalController } from './sectors/internal/internal.controller';
import { DistributionController } from './sectors/distribution/distribution.controller';
import { TrackController } from './sectors/delivery/track.controller';
import { FilesController, MAX_FILE_BYTES } from './files/files.controller';
import { raw } from 'express';
import { MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { MaintenanceService } from './maintenance/maintenance.service';

@Module({
  controllers: [HealthController, AuthController, TenantsController, MembersController, OrgController, AssetsController, WorkersController, DocumentsController, DriverController, DispatchController, TrackingController, ReportsController, CustomersController, ContractsController, PortalController, MaintenanceController, ExpensesController, InvoicesController, PaymentsController, DeliveryController, ConcreteController, StaffingController, InternalController, DistributionController, TrackController, FilesController, TasksController],
  providers: [
    DbService,
    OtpService,
    SessionService,
    AuthGuard,
    MaintenanceService,
    { provide: SMS_SENDER, useFactory: () => smsSenderFromEnv() },
  ],
})
export class AppModule implements NestModule {
  /** Raw image bodies for the driver's file upload only; every other route keeps the JSON parser. */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_FILE_BYTES })).forRoutes({ path: 'v1/driver/files', method: RequestMethod.POST });
  }
}
