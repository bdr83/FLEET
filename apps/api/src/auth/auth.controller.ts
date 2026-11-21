import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { normalizePhone } from '../common/phone';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { bearer, isUuid, sign, USER_TTL_SEC, verifyUserToken } from './tokens';

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly db: DbService, private readonly otp: OtpService, private readonly sessions: SessionService) {}

  @Post('otp/request')
  @HttpCode(202)
  async requestOtp(@Body() body: { phone?: string }) {
    const phone = normalizePhone(body?.phone);
    if (!phone) throw new BadRequestException('invalid phone');
    const r = await this.otp.request(phone);
    return { status: 'sent', ...(r.devCode ? { dev_code: r.devCode } : {}) };
  }

  /** Proves the phone, creates the global identity on first login, and lists the user's companies. */
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() body: { phone?: string; code?: string }) {
    const phone = normalizePhone(body?.phone);
    if (!phone || !(await this.otp.verify(phone, String(body?.code ?? '')))) throw new UnauthorizedException();
    const userId = await this.db.withoutTenant(async (c) => {
      const r = await c.query(
        `INSERT INTO org.app_user (id, phone) VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET phone = EXCLUDED.phone RETURNING id`, [randomUUID(), phone]);
      return r.rows[0].id as string;
    });
    return { user_token: sign({ typ: 'user', sub: userId }, USER_TTL_SEC), memberships: await this.memberships(userId) };
  }

  @Get('memberships')
  async listMemberships(@Req() req: never) {
    const u = verifyUserToken(bearer(req));
    return { memberships: await this.memberships(u.sub) };
  }

  /** Exchanges a user token for a session inside one company the user belongs to. */
  @Post('token')
  @HttpCode(200)
  async token(@Req() req: never, @Body() body: { tenant_id?: string }, @Headers('user-agent') ua?: string) {
    const u = verifyUserToken(bearer(req));
    if (!isUuid(body?.tenant_id)) throw new BadRequestException('tenant_id required');
    const ok = (await this.memberships(u.sub)).some((m) => m.tenant_id === body.tenant_id);
    if (!ok) throw new ForbiddenException();
    return this.db.withTenant({ tenantId: body.tenant_id!, entityIds: [] }, (c) => this.sessions.issue(c, body.tenant_id!, u.sub, ua));
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: { refresh_token?: string }, @Headers('user-agent') ua?: string) {
    return this.sessions.refresh(body?.refresh_token, ua);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: { refresh_token?: string }) {
    await this.sessions.revoke(body?.refresh_token);
  }

  private async memberships(userId: string) {
    return this.db.withoutTenant(async (c) => (await c.query('SELECT * FROM auth.user_memberships($1)', [userId])).rows as
      { tenant_id: string; tenant_name: string; tenant_status: string; role_code: string }[]);
  }
}
