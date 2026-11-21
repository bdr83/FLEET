import { BadRequestException, Body, Controller, Get, Header, Headers, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type { Response } from 'express';
import { AuthContext, AuthGuard, Perm } from '../auth/auth.guard';
import { Auth } from '../auth/auth.decorator';
import { DbService } from '../db/db.service';
import { v } from '../common/validate';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const PURPOSES = ['pod', 'expense', 'document'] as const;

/** Checks the file really is the image type it claims (magic bytes), not just the header. */
export function sniff(b: Buffer): (typeof TYPES)[number] | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Small image files (proof-of-delivery photos first). The driver app uploads the raw image and gets a
 * file_key ("file:<id>") to put in a pod op. Kept in the database for the pilot; object storage later. [تحقق محلي]
 */
@Controller('v1')
@UseGuards(AuthGuard)
export class FilesController {
  constructor(private readonly db: DbService) {}

  /** Raw image body (Content-Type image/jpeg|png|webp, ≤ 2 MB). Idempotent on client_op_id so offline retries are safe. */
  @Post('driver/files')
  @Perm('tasks:update_own')
  upload(@Auth() a: AuthContext, @Body() body: unknown, @Headers('content-type') type: string | undefined,
    @Query('purpose') purpose?: string, @Query('client_op_id') op?: string) {
    const p = v.oneOf(purpose ?? 'pod', 'purpose', PURPOSES)!;
    const opId = v.uuid(op, 'client_op_id', { required: true })!;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException(`send the image as the request body (${TYPES.join(', ')}, up to 2 MB)`);
    const real = sniff(body);
    if (!real || real !== (type ?? '').split(';')[0].trim()) throw new BadRequestException('file is not the image type it claims');
    const sha = createHash('sha256').update(body).digest('hex');
    return this.db.withTenant(a, async (c) => {
      const prior = (await c.query('SELECT id, size_bytes, content_type FROM ops.file_blob WHERE client_op_id = $1', [opId])).rows[0];
      if (prior) return { file_key: `file:${prior.id}`, size_bytes: prior.size_bytes, content_type: prior.content_type, duplicate: true };
      const id = randomUUID();
      await c.query(
        `INSERT INTO ops.file_blob (id, tenant_id, purpose, content_type, size_bytes, sha256, bytes, created_by, client_op_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, a.tenantId, p, real, body.length, sha, body, a.userId, opId]);
      return { file_key: `file:${id}`, size_bytes: body.length, content_type: real };
    });
  }

  /** The office views a file (e.g. a proof photo). Other companies get 404. */
  @Get('files/:id')
  @Perm('tasks:read')
  @Header('Cache-Control', 'private, max-age=3600')
  async get(@Auth() a: AuthContext, @Param('id', new ParseUUIDPipe()) id: string, @Res() res: Response) {
    const f = await this.db.withTenant(a, async (c) => (await c.query('SELECT content_type, bytes FROM ops.file_blob WHERE id = $1', [id])).rows[0]);
    if (!f) throw new NotFoundException();
    res.setHeader('Content-Type', f.content_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.send(f.bytes);
  }
}
