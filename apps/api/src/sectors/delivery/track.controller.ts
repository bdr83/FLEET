import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { DbService } from '../../db/db.service';

/**
 * The recipient's tracking page data: no login, the link token is the only key (192 random bits).
 * The database function returns a fixed, limited set of fields (no phone numbers, no full names,
 * the driver's position only while heading to the recipient). An unknown or expired token is a 404.
 */
@Controller('v1/public/track')
export class TrackController {
  constructor(private readonly db: DbService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex')
  async track(@Param('token') token: string) {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw new NotFoundException();
    const r = await this.db.withoutTenant((c) => c.query('SELECT ops.public_delivery_track($1) AS t', [token]));
    const t = r.rows[0]?.t;
    if (!t) throw new NotFoundException();
    return t;
  }
}
