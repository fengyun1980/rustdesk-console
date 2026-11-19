import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { GeneralSettingsService } from '../settings/services/general-settings.service';
import { UpdateGeneralSettingsDto } from '../settings/dto/general-settings.dto';
import { WebClientSettingsService } from '../web-client/web-client-settings.service';
import { UpdateWebClientSettingsDto } from '../web-client/dto/web-client-settings.dto';
import { WebClientService } from '../web-client/web-client.service';
import { ServerManagementSettingsService } from '../server-management/server-management-settings.service';
import { UpdateServerManagementSettingsDto } from '../server-management/dto/server-management-settings.dto';
import { DEFAULT_NODE_ID, DEFAULT_NODE_NAME } from '../server-management/server-management-settings.service';
import { JWT_DEFAULT_SECRET } from '../auth/auth.constants';
import { User } from '../user/entities/user.entity';
import { CompleteSetupDto } from './dto/complete-setup.dto';

/** hbbs management API port (Server Pro default) */
const HBBS_MANAGEMENT_PORT = 21120;

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
  serverManagement: {
    url: string;
    tokenConfigured: boolean;
    usingDefaultSecret: boolean;
    nodeId: string;
    nodeName: string;
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
    private readonly serverManagementSettingsService: ServerManagementSettingsService,
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

    // ---- Pre-check & write: admin username + password (must succeed first) ----
    const adminUser = await this.userRepository.findOne({
      where: { isAdmin: true },
    });
    if (!adminUser) {
      throw new BadRequestException('No admin user found');
    }
    adminUser.username = dto.adminUsername;
    adminUser.password = await bcrypt.hash(dto.adminPassword, 10);
    adminUser.displayName = dto.adminUsername;
    await this.userRepository.save(adminUser);
    const passwordChanged = true;
    this.logger.log(
      `Admin credentials set during setup wizard. username=${dto.adminUsername}`,
    );

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

    // ---- Auto-configure hbbs management API (ServerManagement) ----
    // Console and hbbs share one JWT_SECRET in integrated deployments, so the
    // hbbs management API Bearer token is just our JWT secret. The management
    // API port is Server Pro default 21120; host follows the console origin.
    const jwtSecret = process.env.JWT_SECRET || JWT_DEFAULT_SECRET;
    const usingDefaultSecret = !process.env.JWT_SECRET;
    const managementUrl = `http://${parsed.host}:${HBBS_MANAGEMENT_PORT}`;
    const smUpdate: UpdateServerManagementSettingsDto = {
      url: managementUrl,
      token: jwtSecret,
      nodeId: DEFAULT_NODE_ID,
      nodeName: DEFAULT_NODE_NAME,
    };
    let smConfigured = true;
    try {
      await this.serverManagementSettingsService.updateSettings(smUpdate);
    } catch (error) {
      smConfigured = false;
      warnings.push({
        code: 'server_management_config_failed',
        message: `Auto-configure hbbs management API failed: ${String(error)}. Configure it manually in "Settings → Server Management".`,
      });
    }
    if (smConfigured && usingDefaultSecret) {
      warnings.push({
        code: 'jwt_default_secret',
        message:
          'JWT_SECRET is not set — using the default development secret. Set it via environment variable in production.',
      });
    }

    this.logger.log(
      `Setup wizard completed. origin=${origin}, webClientEnabled=${webClientEnabled}, serverManagementConfigured=${smConfigured}, usingDefaultSecret=${usingDefaultSecret}, passwordChanged=${passwordChanged}`,
    );

    const result: SetupCompletionResult = {
      completed: true,
      origin,
      webClient: {
        eligible: webClientEligible,
        enabled: webClientEnabled,
      },
      serverManagement: {
        url: managementUrl,
        tokenConfigured: smConfigured,
        usingDefaultSecret,
        nodeId: DEFAULT_NODE_ID,
        nodeName: DEFAULT_NODE_NAME,
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
    if (typeof input !== 'string' || !input.trim()) {
      throw new BadRequestException('serverUrl is required');
    }
    if (input !== input.trim() || /[\s\\?#]/.test(input)) {
      throw new BadRequestException(
        'serverUrl must be an http(s) origin without path, query, fragment or whitespace',
      );
    }

    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new BadRequestException('serverUrl is not a valid URL');
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('serverUrl must use http or https');
    }

    if (url.username || url.password) {
      throw new BadRequestException('serverUrl must not contain credentials');
    }

    if (url.pathname && url.pathname !== '/') {
      throw new BadRequestException('serverUrl must not contain a path');
    }

    return url.origin;
  }
}
