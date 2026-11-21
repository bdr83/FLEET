import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../db/db.service';

const EVERY_MS = 6 * 3_600_000;
const LOCK_KEY = 7_340_001; // one instance at a time when several API replicas run

/**
 * Housekeeping that must keep running in production: creates the coming days'
 * location partitions and drops those older than the retention period (D6: 90 days).
 * Runs at startup and every 6 hours. Set MAINTENANCE_DISABLED=1 to run it from an external scheduler instead.
 */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Maintenance');
  private timer?: NodeJS.Timeout;

  constructor(private readonly db: DbService) {}

  onModuleInit() {
    if (process.env.MAINTENANCE_DISABLED === '1') return;
    void this.run();
    this.timer = setInterval(() => void this.run(), EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<boolean> {
    const days = Number(process.env.LOCATION_RETENTION_DAYS ?? 90);
    try {
      return await this.db.withoutTenant(async (c) => {
        const got = (await c.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [LOCK_KEY])).rows[0].ok;
        if (!got) return false;
        await c.query('SELECT geo.maintain_location_partitions(7, $1)', [days]);
        return true;
      });
    } catch (e) {
      this.log.error(`location partition maintenance failed: ${(e as Error).message}`);
      return false;
    }
  }
}
