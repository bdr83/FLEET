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
import { MaintenanceService } from './maintenance/maintenance.service';

@Module({
  controllers: [HealthController, AuthController, TenantsController, MembersController, OrgController, AssetsController, WorkersController, DocumentsController, DriverController, DispatchController, TrackingController, ReportsController, CustomersController, ContractsController, PortalController, MaintenanceController, ExpensesController, InvoicesController, PaymentsController, TasksController],
  providers: [
    DbService,
    OtpService,
    SessionService,
    AuthGuard,
    MaintenanceService,
    { provide: SMS_SENDER, useClass: LogSmsSender },
  ],
})
export class AppModule {}
