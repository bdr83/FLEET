import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthContext } from './auth.guard';

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  return ctx.switchToHttp().getRequest().auth;
});
