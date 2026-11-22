import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { normalizePhone } from '../common/phone';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { bearer, isUuid, sign, USER_TTL_SEC, verifyAccessToken, verifyUserToken } from './tokens';
import { PasswordService } from './password.service';

const appUrl = () => process.env.APP_PUBLIC_URL || 'http://localhost:3001';

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly db: DbService, private readonly otp: OtpService, private readonly sessions: SessionService,
              private readonly passwords: PasswordService) {}

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

  /** Which login methods this server offers, so the login page can hide what is not set up. */
  @Get('methods')
  methods() {
    return { password: true, password_reset: this.passwords.mailConfigured };
  }

  @Post('register')
  @HttpCode(201)
  async register(@Body() body: { email?: string; password?: string; display_name?: string }) {
    return this.userSession(await this.passwords.register(body?.email, body?.password, body?.display_name));
  }

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email?: string; password?: string }) {
    return this.userSession(await this.passwords.login(body?.email, body?.password));
  }

  @Post('password/forgot')
  @HttpCode(202)
  async forgot(@Body() body: { email?: string }) {
    const r = await this.passwords.forgot(body?.email, appUrl());
    return { status: 'sent', ...(r.devToken ? { dev_token: r.devToken } : {}) };
  }

  @Post('password/reset')
  @HttpCode(200)
  async reset(@Body() body: { token?: string; password?: string }) {
    return this.userSession(await this.passwords.reset(body?.token, body?.password));
  }

  /** Signed-in user (access token) changes their own password. */
  @Post('password/change')
  @HttpCode(204)
  async change(@Req() req: never, @Body() body: { current_password?: string; new_password?: string }) {
    const a = verifyAccessToken(bearer(req));
    await this.passwords.change(a.sub, body?.current_password, body?.new_password);
  }

  private async userSession(userId: string) {
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
