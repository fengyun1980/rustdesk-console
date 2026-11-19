import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Like, QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
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

    const adminUsername = 'databk';
    const adminEmail = 'databk@github.com';
    const configuredPassword = process.env.ADMIN_PASSWORD;
    const adminPassword = configuredPassword ?? 'databk';
    if (adminPassword.length === 0) {
      throw new Error('ADMIN_PASSWORD must not be empty');
    }

    if (configuredPassword === undefined) {
      this.logger.warn(
        'ADMIN_PASSWORD is not set; using the legacy default. Please change it immediately after first login!',
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
}
