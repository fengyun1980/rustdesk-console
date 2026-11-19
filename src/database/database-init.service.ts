import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Like, QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { User, UserStatus } from '../modules/user/entities/user.entity';
import { OidcProvider } from '../modules/oidc/entities/oidc-provider.entity';
import { OidcAuthState } from '../modules/oidc/entities/oidc-auth-state.entity';
import { SystemSetting } from '../modules/settings/entities/system-setting.entity';
import { UserGroupService } from '../modules/user-group/user-group.service';

@Injectable()
/**
 * DatabaseInitService
 * Handles database initialization and creation of preset data
 *
 * Use case:
 * Runs automatically at application startup to ensure the database structure and preset data are correct
 */
export class DatabaseInitService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseInitService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(OidcProvider)
    private oidcProviderRepository: Repository<OidcProvider>,
    @InjectRepository(OidcAuthState)
    private oidcAuthStateRepository: Repository<OidcAuthState>,
    @InjectRepository(SystemSetting)
    private systemSettingRepository: Repository<SystemSetting>,
    private readonly userGroupService: UserGroupService,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    const defaultGroup = await this.userGroupService.initializeStorage();
    const owners = await this.userRepository.count({
      where: { isAdmin: true },
    });
    if (owners > 1) {
      throw new Error(
        `Database contains ${owners} system owners; resolve the duplicate isAdmin rows offline before starting the server`,
      );
    }
    // The partial unique index is the database-level owner boundary. Creating
    // it after the explicit legacy check keeps duplicate historical owners
    // readable and reports them with the actionable error above.
    // SQLite supports partial indexes (`WHERE` clause); MySQL does not, so we
    // rely on the application-level check above for MySQL deployments.
    if (this.dataSource.options.type === 'sqlite') {
      try {
        await this.dataSource.query(
          'CREATE UNIQUE INDEX IF NOT EXISTS UQ_users_single_owner ON users (isAdmin) WHERE isAdmin = 1',
        );
      } catch (error: unknown) {
        if (error instanceof QueryFailedError) {
          const currentOwners = await this.userRepository.count({
            where: { isAdmin: true },
          });
          if (currentOwners > 1) {
            throw new Error(
              `Database contains ${currentOwners} system owners; resolve the duplicate isAdmin rows offline before starting the server`,
            );
          }
        }
        throw error;
      }
    }
    await this.createDefaultAdmin(defaultGroup.guid);
    await this.cleanupUnusedDefaultOidcProviders();
    await this.cleanupExpiredAuthStates();
    await this.bootstrapServerManagementFromEnv();
    await this.bootstrapWebClientFromEnv();
  }

  /**
   * Create the default administrator account
   */
  private async createDefaultAdmin(defaultGroupGuid: string) {
    // Check whether an administrator user already exists in the database
    const existingAdmin = await this.userRepository.findOne({
      where: { isAdmin: true },
    });

    if (existingAdmin) {
      this.logger.log('Admin user already exists, skipping creation');
      return;
    }

    const adminUsername = process.env.ADMIN_USERNAME?.trim() || 'admin';
    const adminEmail =
      process.env.ADMIN_EMAIL?.trim() || `${adminUsername}@local`;
    const configuredPassword = process.env.ADMIN_PASSWORD;
    const adminPassword = configuredPassword ?? 'admin';
    if (adminPassword.length === 0) {
      throw new Error('ADMIN_PASSWORD must not be empty');
    }

    if (configuredPassword === undefined) {
      this.logger.warn(
        'ADMIN_PASSWORD is not set; using the default value. Please change it immediately after first login!',
      );
    }

    const admin = this.userRepository.create({
      guid: uuidv4(),
      username: adminUsername,
      email: adminEmail,
      password: await bcrypt.hash(adminPassword, 10),
      status: UserStatus.ACTIVE,
      isAdmin: true,
      note: 'Default administrator account',
      userGroupGuid: defaultGroupGuid,
    });

    try {
      await this.userRepository.save(admin);
    } catch (error: unknown) {
      // Another process may have won the empty-database race after the
      // unique index was installed. Treat that loser as an idempotent start.
      if (error instanceof QueryFailedError) {
        const owner = await this.userRepository.findOne({
          where: { isAdmin: true },
        });
        if (owner) return;
      }
      throw error;
    }
    this.logger.log(`Default admin user created: ${adminUsername}`);
  }

  /**
   * Clean up unused default OIDC providers
   *
   * Early versions automatically inserted two default OIDC providers, google and github, during initialization.
   * That automatic behavior has been removed; this cleans up the legacy default providers:
   * Only when the provider name is google/github, no clientId is configured, it is not enabled, and no user has logged in via
   * that provider will it be deleted, to avoid removing providers users have configured or are using.
   */
  private async cleanupUnusedDefaultOidcProviders() {
    const defaultProviderNames = ['google', 'github'];

    for (const name of defaultProviderNames) {
      const provider = await this.oidcProviderRepository.findOne({
        where: { name },
      });

      if (!provider) {
        continue;
      }

      if (provider.clientId !== '') {
        continue;
      }

      if (provider.enabled) {
        continue;
      }

      const linkedUserCount = await this.userRepository.count({
        where: { oidcSubject: Like(`oidc:${name}:%`) },
      });

      if (linkedUserCount > 0) {
        continue;
      }

      await this.oidcProviderRepository.delete({ guid: provider.guid });
      this.logger.log(`Removed unused default OIDC provider: ${name}`);
    }
  }

  /**
   * Clean up expired authorization states
   */
  private async cleanupExpiredAuthStates() {
    const result = await this.oidcAuthStateRepository
      .createQueryBuilder()
      .delete()
      .where('expiresAt < :now', { now: new Date() })
      .execute();

    if (result.affected && result.affected > 0) {
      this.logger.log(`Cleaned up ${result.affected} expired OIDC auth states`);
    }
  }

  /**
   * Bootstrap server-management and related settings from environment variables.
   *
   * This enables "deploy-and-use" all-in-one setups where docker-compose
   * spins up hbbs/hbbr alongside the console. The values are written only when
   * the corresponding key is not yet present in system_settings, so an
   * administrator's later change in Settings is never overwritten on restart.
   *
   * Environment variables (all optional):
   *   SERVER_MANAGEMENT_URL      e.g. http://hbbs:21120
   *   SERVER_MANAGEMENT_TOKEN    hbbs management token (>= 32 chars)
   *   SERVER_MANAGEMENT_NODE_ID  defaults to 'rustdesk'
   *   SERVER_MANAGEMENT_NODE_NAME defaults to 'RustDesk'
   *
   *   SITE_URL                   Public URL of this console (optional)
   */
  private async bootstrapServerManagementFromEnv() {
    const url = process.env.SERVER_MANAGEMENT_URL?.trim();
    const token = process.env.SERVER_MANAGEMENT_TOKEN;
    if (!url || !token) {
      // Nothing to bootstrap; this is the normal path for non-AIO deployments.
      return;
    }
    if (token.length < 32) {
      this.logger.warn(
        'SERVER_MANAGEMENT_TOKEN must be at least 32 characters; skipping automatic server management bootstrap',
      );
      return;
    }

    const nodeId = process.env.SERVER_MANAGEMENT_NODE_ID?.trim() || 'rustdesk';
    const nodeName =
      process.env.SERVER_MANAGEMENT_NODE_NAME?.trim() || 'RustDesk';

    const pairs: Array<[string, string, boolean]> = [
      ['serverManagement.url', url, false],
      ['serverManagement.token', token, true],
      ['serverManagement.nodeId', nodeId, false],
      ['serverManagement.nodeName', nodeName, false],
    ];

    let applied = 0;
    for (const [key, value, isSensitive] of pairs) {
      const existing = await this.systemSettingRepository.findOne({
        where: { key },
      });
      if (existing) {
        continue;
      }
      await this.systemSettingRepository.save(
        this.systemSettingRepository.create({
          key,
          value,
          category: 'serverManagement',
          description: `Auto-bootstrapped from ${key} env var`,
          isSensitive,
        }),
      );
      applied += 1;
    }

    if (applied > 0) {
      this.logger.log(
        `Server management auto-bootstrapped ${applied} setting(s) from environment variables`,
      );
    }
  }

  /**
   * Bootstrap Web Client settings for All-in-One setups.
   *
   * 在 All-in-One 里 Console、hbbs、hbbr 三个容器共享宿主机目录 ./data，
   * 所以 Console 能直接从 /data/server/id_ed25519.pub 读取 hbbs 自动生成的公钥。
   * 同时结合环境变量 PUBLIC_HOST 构造出外部 WSS 地址和内部直连 upstream。
   *
   * allowedOrigin 必须是完整 HTTPS origin，后端校验强制 https:。
   * 因此只有用户显式提供了 WEB_CLIENT_ORIGIN=https://... 时才会把 enabled 置为 true；
   * 其他字段（upstream、公钥、WSS 地址）仍然写入，等用户后续配好 HTTPS 只需改两处。
   *
   * 写入原则：只在对应 key 不存在时写入，不覆盖管理员的手动修改。
   */
  private async bootstrapWebClientFromEnv(): Promise<void> {
    const category = 'webClient';
    const dataDir = process.env.DATA_DIR || '/data';
    const serverDir = resolve(dataDir, 'server');
    const publicKeyPath = resolve(serverDir, 'id_ed25519.pub');

    // Fast path: hbbs 容器没跑 / 数据目录为空 → 根本不会有公钥，
    // 直接 skip 避免单元测试或普通部署里白等 60 秒。
    if (!existsSync(serverDir)) {
      this.logger.debug(
        `[AIO] hbbs data dir not found at ${serverDir}; skipping Web Client auto-bootstrap`,
      );
      return;
    }

    // Poll only when the directory exists (hbbs 数据已挂载) but the key file has not appeared yet.
    let publicKey: string | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(publicKeyPath)) {
        const content = readFileSync(publicKeyPath, 'utf8').trim();
        const match = content.match(/^ssh-ed25519\s+([A-Za-z0-9+/=]+)/);
        if (match) {
          publicKey = match[1];
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!publicKey) {
      this.logger.warn(
        `[AIO] hbbs public key not found at ${publicKeyPath} within 60s; ` +
          'skipping Web Client auto-bootstrap (hbbs may still be starting).',
      );
      return;
    }

    const publicHost =
      process.env.PUBLIC_HOST?.trim() ||
      process.env.RUSTDESK_RELAY_ADDRESS?.trim()?.split(':')[0];
    const relayAddress =
      process.env.RUSTDESK_RELAY_ADDRESS?.trim() || 'relay-placeholder:21117';
    // relayAddress 形如 host:port，id 端口是 host:21118
    const relayHost = relayAddress.split(':')[0];
    const wssIdHost = `${relayHost}:21118`;
    const wssRelayHost = `${relayHost}:21119`;

    const allowedOrigin = process.env.WEB_CLIENT_ORIGIN?.trim();
    const enableWebClient =
      !!allowedOrigin && allowedOrigin.startsWith('https://');

    const pairs: Array<[string, string, boolean]> = [
      // 外部公开 WebSocket（浏览器实际连接）
      ['webClient.idServerUrl', `wss://${wssIdHost}/ws`, false],
      ['webClient.relayServerUrl', `wss://${wssRelayHost}/ws`, false],
      // 服务器公钥（从 hbbs 读出来的）
      ['webClient.serverPublicKey', publicKey, true],
      // 内部直连（让 Console Gateway 绕过公网直接连 hbbs/hbbr）
      ['webClient.idUpstreamUrl', 'ws://hbbs:21118/ws/id', false],
      ['webClient.relayUpstreamUrl', 'ws://hbbr:21119/ws/relay', false],
      // 启用开关（只有用户提供 HTTPS origin 时才启用）
      ['webClient.enabled', String(enableWebClient), false],
    ];

    if (allowedOrigin) {
      pairs.push(['webClient.allowedOrigin', allowedOrigin, false]);
    }

    let applied = 0;
    for (const [key, value] of pairs) {
      const existing = await this.systemSettingRepository.findOne({
        where: { key },
      });
      if (existing) continue;
      await this.systemSettingRepository.save(
        this.systemSettingRepository.create({
          key,
          value,
          category,
          description: `Auto-bootstrapped by DatabaseInitService (AIO)`,
          isSensitive: key.includes('PublicKey'),
        }),
      );
      applied += 1;
    }

    if (applied > 0) {
      if (enableWebClient) {
        this.logger.log(
          `[AIO] Web Client enabled and auto-configured (${applied} setting(s))`,
        );
      } else {
        this.logger.log(
          `[AIO] Web Client skeleton configured (${applied} setting(s)); ` +
            `disabled — provide WEB_CLIENT_ORIGIN=https://... to enable`,
        );
      }
    }
  }
}
