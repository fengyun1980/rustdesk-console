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

    // Fast path: hbbs 数据目录都不存在 → 肯定没有公钥（非 AIO 场景），直接 skip。
    if (!existsSync(serverDir)) {
      this.logger.debug(
        `[AIO] hbbs data dir not found at ${serverDir}; skipping Web Client auto-bootstrap`,
      );
      return;
    }

    // ---- 1. 决定 serverUrl 协议（wss vs ws）和 enabled 条件 ----
    const allowedOrigin = process.env.WEB_CLIENT_ORIGIN?.trim();
    const consolePublicUrl = process.env.CONSOLE_PUBLIC_URL?.trim();

    // 从 origin / consoleUrl 推导公网 host:port
    let serverHost: string;
    let serverPort: string | undefined;
    if (consolePublicUrl) {
      try {
        const u = new URL(consolePublicUrl);
        serverHost = u.hostname;
        serverPort = u.port || undefined;
      } catch {
        serverHost = consolePublicUrl.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
      }
    } else if (allowedOrigin) {
      try {
        const u = new URL(allowedOrigin);
        serverHost = u.hostname;
        serverPort = u.port || undefined;
      } catch {
        serverHost = allowedOrigin.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
      }
    } else {
      // 没有反代域名 → 用探测到的 PUBLIC_HOST + Console 端口
      serverHost =
        process.env.PUBLIC_HOST?.trim() ||
        'console.local';
      const consolePort = process.env.PORT?.trim() || '21114';
      serverPort = consolePort;
    }

    // 决定 WSS vs WS：
    //   origin 以 https:// 开头 → wss://
    //   origin 以 http:// 开头 → ws://（混合内容阻止）
    //   没有 origin 也没有 consolePublicUrl → ws://（裸 IP 场景）
    let wsProtocol: 'wss:' | 'ws:';
    let enableWebClient: boolean;
    if (allowedOrigin?.startsWith('https://')) {
      wsProtocol = 'wss:';
      enableWebClient = true;
    } else if (allowedOrigin?.startsWith('http://')) {
      wsProtocol = 'ws:';
      enableWebClient = true;
      this.logger.warn(
        '[AIO] Web Client using HTTP origin — secure WSS is unavailable over HTTP pages. ' +
          'This is acceptable for trusted LAN deployments.',
      );
    } else if (consolePublicUrl?.startsWith('https://')) {
      wsProtocol = 'wss:';
      enableWebClient = true;
    } else {
      wsProtocol = 'ws:';
      // 完全没有 origin 配置 → 内网裸 IP 场景：也尝试启用（serverUrl 用 ws://）
      enableWebClient = true;
      this.logger.log(
        '[AIO] No explicit origin configured; Web Client will use ws:// with bare IP.',
      );
    }

    const serverUrlBase = serverPort ? `${serverHost}:${serverPort}` : serverHost;
    const idServerUrl = `${wsProtocol}//${serverUrlBase}/ws/id`;
    const relayServerUrl = `${wsProtocol}//${serverUrlBase}/ws/relay`;

    // ---- 2. 尝试读 hbbs 公钥（最多等 60 秒） ----
    let publicKey: string | undefined;
    const findPublicKey = async (): Promise<string | undefined> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (existsSync(publicKeyPath)) {
          const content = readFileSync(publicKeyPath, 'utf8').trim();
          const match = content.match(/^ssh-ed25519\s+([A-Za-z0-9+/=]+)/);
          if (match) {
            const blob = Buffer.from(match[1], 'base64');
            const keytypeLen = blob.readUInt32BE(0);
            const pubkeyLen = blob.readUInt32BE(4 + keytypeLen);
            const pubkeyStart = 4 + keytypeLen + 4;
            const rawPubkey = blob.slice(pubkeyStart, pubkeyStart + pubkeyLen);
            if (rawPubkey.length === 32) {
              return rawPubkey.toString('base64');
            }
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return undefined;
    };

    publicKey = await findPublicKey();

    if (!publicKey) {
      this.logger.warn(
        `[AIO] hbbs public key not found at ${publicKeyPath} within 60s. ` +
          'Will retry in background (hbbs may still be initializing).',
      );
      // 定时重检：每 30s 试一次，最多 40 次（~20 分钟）
      // 用 setInterval 不阻塞启动；成功后写入 settings 并自动启用 Gateway
      let retries = 0;
      const MAX_RETRIES = 40;
      const retryTimer = setInterval(async () => {
        retries += 1;
        const pk = await findPublicKey();
        if (pk) {
          clearInterval(retryTimer);
          this.logger.log(
            `[AIO] Retry #${retries}: hbbs public key recovered. Writing Web Client settings.`,
          );
          await this._writeWebClientSettings(
            pk, idServerUrl, relayServerUrl, allowedOrigin,
            enableWebClient, category,
          );
        } else if (retries >= MAX_RETRIES) {
          clearInterval(retryTimer);
          this.logger.error(
            `[AIO] hbbs public key still unavailable after ${MAX_RETRIES} retries. ` +
              'Web Client auto-bootstrap aborted. Fix hbbs container and restart Console.',
          );
        }
      }, 30_000);
      return;
    }

    // ---- 3. 写入 settings ----
    await this._writeWebClientSettings(
      publicKey, idServerUrl, relayServerUrl, allowedOrigin,
      enableWebClient, category,
    );
  }

  /**
   * 幂等写入 Web Client settings。只写不存在的 key，不覆盖管理员修改。
   */
  private async _writeWebClientSettings(
    publicKey: string,
    idServerUrl: string,
    relayServerUrl: string,
    allowedOrigin: string | undefined,
    enableWebClient: boolean,
    category: string,
  ): Promise<void> {
    const pairs: Array<[string, string, boolean]> = [
      ['webClient.idServerUrl', idServerUrl, false],
      ['webClient.relayServerUrl', relayServerUrl, false],
      ['webClient.serverPublicKey', publicKey, true],
      ['webClient.idUpstreamUrl', 'ws://hbbs:21118', false],
      ['webClient.relayUpstreamUrl', 'ws://hbbr:21119', false],
      ['webClient.enabled', String(enableWebClient), false],
    ];
    if (allowedOrigin) {
      pairs.push(['webClient.allowedOrigin', allowedOrigin, false]);
    }

    // 占位符关键词 — 数据库里残留这些值时必须覆盖
    const PLACEHOLDER_PATTERNS = [
      'example.com',
      'console.example',
      'wss://console',
      'ws://console',
      'console.local',
    ];
    const FORCE = process.env.FORCE_WEB_CLIENT_BOOTSTRAP === '1';

    let applied = 0;
    let overwritten = 0;
    for (const [key, value, isSensitive] of pairs) {
      const existing = await this.systemSettingRepository.findOne({
        where: { key },
      });

      // 跳过条件：key 已存在 + 值不是占位符 + 没开 FORCE
      if (existing && !FORCE) {
        const oldVal = (existing.value || '').toLowerCase();
        const isPlaceholder = PLACEHOLDER_PATTERNS.some((p) =>
          oldVal.includes(p),
        );
        const isEmpty = !oldVal || oldVal.trim() === '';
        if (!isPlaceholder && !isEmpty) continue;
      }

      await this.systemSettingRepository.save(
        this.systemSettingRepository.create({
          key,
          value,
          category,
          description: FORCE
            ? `Force-refreshed by AIO bootstrap (FORCE_WEB_CLIENT_BOOTSTRAP=1)`
            : `Auto-bootstrapped by DatabaseInitService (AIO)`,
          isSensitive,
        }),
      );
      if (existing) overwritten += 1;
      else applied += 1;
    }

    const total = applied + overwritten;
    if (total > 0) {
      const parts: string[] = [];
      if (applied > 0) parts.push(`${applied} new`);
      if (overwritten > 0) parts.push(`${overwritten} overwritten`);
      const verb = enableWebClient ? 'ENABLED' : 'disabled';
      this.logger.log(
        `[AIO] Web Client auto-configured (${parts.join(', ')}) — ${verb}`,
      );
    }
  }
}
