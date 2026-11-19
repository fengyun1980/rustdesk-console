import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GeneralSettingsService } from '../settings/services/general-settings.service';
import { UpdateGeneralSettingsDto } from '../settings/dto/general-settings.dto';
import { WebClientSettingsService } from '../web-client/web-client-settings.service';
import { UpdateWebClientSettingsDto } from '../web-client/dto/web-client-settings.dto';
import { WebClientService } from '../web-client/web-client.service';
import { UserService } from '../user/user.service';
import { User } from '../user/entities/user.entity';
import { CompleteSetupDto } from './dto/complete-setup.dto';

export interface SetupStatus {
  completed: boolean;
}

export interface SetupCompletionWarning {
  code: string;
  message: string;
}

export interface SetupCompletionResult {
  completed: true;
  origin: string;
  webClient: {
    eligible: boolean;
    enabled: boolean;
    idServerUrl?: string;
    relayServerUrl?: string;
    allowedOrigin?: string;
  };
  passwordChanged: boolean;
  warnings: SetupCompletionWarning[];
}

// In-process lock to prevent concurrent duplicate submissions while the setup
// wizard is being completed. Simple boolean is sufficient because setup runs
// exactly once ever per install.
let setupInProgress = false;

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly generalSettingsService: GeneralSettingsService,
    private readonly webClientSettingsService: WebClientSettingsService,
    private readonly webClientService: WebClientService,
    private readonly userService: UserService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async getStatus(): Promise<SetupStatus> {
    const { frontendUrl } = await this.generalSettingsService.getSiteSettings();
    return { completed: Boolean(frontendUrl) };
  }

  /**
   * Complete the initial setup wizard.
   * Idempotency: returns 409 if already completed.
   * Atomicity: every pre-check (password, public-key, URL) runs before any
   * write, so a password validation failure never leaves DB half-configured.
   */
  async complete(dto: CompleteSetupDto): Promise<SetupCompletionResult> {
    const status = await this.getStatus();
    if (status.completed) {
      throw new ConflictException('Setup has already been completed');
    }

    if (setupInProgress) {
      throw new ConflictException('Setup is already in progress');
    }
    setupInProgress = true;

    try {
      return await this.doComplete(dto);
    } finally {
      setupInProgress = false;
    }
  }

  private async doComplete(dto: CompleteSetupDto): Promise<SetupCompletionResult> {
    const origin = this.normalizeOrigin(dto.serverUrl);
    const parsed = new URL(origin);
    const isHttps = parsed.protocol === 'https:';
    const isIpHost = /^\d+\.\d+\.\d+\.\d+$|^\[.*\]$/.test(parsed.hostname);

    const warnings: SetupCompletionWarning[] = [];
    if (!isHttps) {
      warnings.push({
        code: 'http_only',
        message:
          'Using HTTP origin. Web client (remote control) and cloud builds require a public HTTPS address.',
      });
    } else if (isIpHost) {
      warnings.push({
        code: 'ip_host',
        message:
          'Using an IP address. Web client requires a stable domain so hbbs relay-servers can match.',
      });
    }

    // ---- Pre-check: optional password change (before any writes) ----
    let passwordChanged = false;
    if (dto.currentAdminPassword || dto.newAdminPassword) {
      if (!dto.currentAdminPassword || !dto.newAdminPassword) {
        throw new BadRequestException(
          'currentAdminPassword and newAdminPassword must be provided together',
        );
      }
      if (dto.newAdminPassword.length < 6) {
        throw new BadRequestException(
          'newAdminPassword must be at least 6 characters',
        );
      }
      const adminUser = await this.findAdminUser();
      if (!adminUser) {
        throw new BadRequestException('No admin user found');
      }
      // changePassword does bcrypt comparison internally; bubbles up as
      // BadRequestException('Current password is incorrect') which we let pass
      await this.userService.changePassword(adminUser.guid, {
        current_password: dto.currentAdminPassword,
        new_password: dto.newAdminPassword,
      });
      passwordChanged = true;
      this.logger.log('Admin password changed during setup wizard');
    }

    // ---- Pre-check: optional public key ----
    let hasValidPublicKey = false;
    if (dto.serverPublicKey) {
      const decoded = Buffer.from(dto.serverPublicKey, 'base64');
      if (decoded.length === 32 && decoded.toString('base64') === dto.serverPublicKey) {
        hasValidPublicKey = true;
      } else {
        warnings.push({
          code: 'invalid_public_key',
          message:
            'Supplied serverPublicKey is not a valid Base64-encoded 32-byte Ed25519 key; web client will not be auto-enabled.',
        });
      }
    }

    // ---- Build web client update plan (only eligible when HTTPS) ----
    let webClientEligible = false;
    let webClientEnabled = false;
    let webClientUpdate: UpdateWebClientSettingsDto | null = null;

    if (isHttps) {
      webClientEligible = true;
      const host = parsed.host; // includes non-default port when present
      const idServerUrl = `wss://${host}/ws/id`;
      const relayServerUrl = `wss://${host}/ws/relay`;
      webClientUpdate = {
        allowedOrigin: origin,
        idServerUrl,
        relayServerUrl,
      };
      if (hasValidPublicKey) {
        webClientUpdate.serverPublicKey = dto.serverPublicKey;
        webClientUpdate.enabled = true;
        webClientEnabled = true;
      } else {
        // Pre-fill addresses but keep disabled; admin enables later once key exists
        webClientUpdate.enabled = false;
        warnings.push({
          code: 'web_client_pending_key',
          message:
            'Web client addresses pre-filled. Paste the Server Pro hbbs id_ed25519.pub into "Settings → Web Client" and enable it.',
        });
      }
    } else {
      warnings.push({
        code: 'web_client_skipped',
        message:
          'Skipped web client configuration: HTTPS origin is required. Configure later in "Settings → Web Client".',
      });
    }

    // ---- Write site URL (commit point, must succeed) ----
    // Fetch current settings so we don't clobber unrelated fields
    const currentGeneral = await this.generalSettingsService.getSettings();
    const siteUpdate: UpdateGeneralSettingsDto = {
      watermarkEnabled: currentGeneral.watermarkEnabled,
      defaultLanguage: currentGeneral.defaultLanguage,
      jwtExpiryDays: currentGeneral.jwtExpiryDays,
      auditRetentionDays: currentGeneral.auditRetentionDays,
      deviceCloneIsolation: currentGeneral.deviceCloneIsolation,
      webauthn: currentGeneral.webauthn,
      site: {
        frontendUrl: origin,
        backendUrl: '', // auto-follows frontend via getSiteSettings()
      },
    };
    await this.generalSettingsService.updateSettings(siteUpdate);

    // ---- Write web client settings (if HTTPS) ----
    if (webClientUpdate) {
      await this.webClientSettingsService.updateSettings(webClientUpdate);
      await this.webClientService.refresh();
    }

    this.logger.log(
      `Setup wizard completed. origin=${origin}, webClientEnabled=${webClientEnabled}, passwordChanged=${passwordChanged}`,
    );

    const result: SetupCompletionResult = {
      completed: true,
      origin,
      webClient: {
        eligible: webClientEligible,
        enabled: webClientEnabled,
      },
      passwordChanged,
      warnings,
    };

    if (webClientUpdate) {
      result.webClient.idServerUrl = webClientUpdate.idServerUrl;
      result.webClient.relayServerUrl = webClientUpdate.relayServerUrl;
      result.webClient.allowedOrigin = webClientUpdate.allowedOrigin;
    }

    return result;
  }

  /**
   * Normalize a user-supplied server URL into an http(s) origin.
   * Strips trailing slashes, rejects non-http(s) protocols, paths, queries,
   * fragments, credentials and whitespace.
   */
  private normalizeOrigin(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new BadRequestException('serverUrl is required');
    }

    // Reject whitespace / backslash / query / fragment outright
    if (/[\s\\?#]/.test(trimmed)) {
      throw new BadRequestException(
        'serverUrl must be an http(s) origin without path, query, fragment or whitespace',
      );
    }

    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new BadRequestException('serverUrl is not a valid URL');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('serverUrl must use http or https');
    }

    if (url.username || url.password) {
      throw new BadRequestException('serverUrl must not contain credentials');
    }

    // Reject anything beyond scheme+host (URL.pathname always starts with '/'
    // so we compare against '/' to check for an empty path)
    if (url.pathname && url.pathname !== '/') {
      throw new BadRequestException('serverUrl must not contain a path');
    }

    // Reconstruct origin (strips default ports, trailing slashes, etc.)
    return url.origin;
  }

  private async findAdminUser(): Promise<User | null> {
    return this.userRepository.findOne({
      where: { isAdmin: true },
      select: ['guid'],
    });
  }
}
