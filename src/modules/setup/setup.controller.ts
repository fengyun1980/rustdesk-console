import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { SetupService, SetupStatus, SetupCompletionResult } from './setup.service';
import { CompleteSetupDto } from './dto/complete-setup.dto';

/**
 * SetupController
 * Public endpoints consumed by the setup wizard UI that runs before the
 * admin account has ever been configured. No JWT guard required.
 */
@Controller('settings/setup')
export class SetupController {
  constructor(private readonly setupService: SetupService) {}

  /**
   * Return whether setup has been completed. The frontend setup page polls
   * this and redirects to login once completed=true.
   */
  @Public()
  @Get()
  getStatus(): Promise<SetupStatus> {
    return this.setupService.getStatus();
  }

  /**
   * Complete the setup wizard. Accepts the server origin plus optional admin
   * password reset and WebClient public key. Performs a best-effort commit:
   * site URL is the commit point; every pre-check must pass before writes.
   */
  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  complete(@Body() dto: CompleteSetupDto): Promise<SetupCompletionResult> {
    return this.setupService.complete(dto);
  }
}
