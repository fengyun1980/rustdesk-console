import { ConflictException, BadRequestException } from '@nestjs/common';
import { SetupService } from './setup.service';
import { CompleteSetupDto } from './dto/complete-setup.dto';

const VALID_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');

describe('SetupService', () => {
  let service: SetupService;
  let mockGeneralSettings: any;
  let mockWebClientSettings: any;
  let mockWebClient: any;
  let mockUserService: any;
  let mockUserRepo: any;

  const createService = () => {
    mockGeneralSettings = {
      getSiteSettings: jest.fn(),
      getSettings: jest.fn(),
      updateSettings: jest.fn(),
    };
    mockWebClientSettings = {
      updateSettings: jest.fn(),
    };
    mockWebClient = {
      refresh: jest.fn(),
    };
    mockUserService = {
      changePassword: jest.fn(),
    };
    mockUserRepo = {
      findOne: jest.fn(),
    };

    service = new SetupService(
      mockGeneralSettings,
      mockWebClientSettings,
      mockWebClient,
      mockUserService,
      mockUserRepo,
    );
  };

  beforeEach(() => {
    // Reset the module-level in-progress lock between tests
    // by re-importing via createService which holds fresh mocks
    createService();
  });

  // ---------- Status detection ----------

  it('reports completed=false when no frontendUrl is configured', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: '',
      backendUrl: '',
      effectiveFrontendUrl: 'http://localhost:3000',
      effectiveBackendUrl: 'http://localhost:3000',
    });
    await expect(service.getStatus()).resolves.toEqual({ completed: false });
  });

  it('reports completed=true when frontendUrl is already set (upgrade path)', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: 'https://rdc.tmnas.top',
      backendUrl: '',
      effectiveFrontendUrl: 'https://rdc.tmnas.top',
      effectiveBackendUrl: 'https://rdc.tmnas.top',
    });
    await expect(service.getStatus()).resolves.toEqual({ completed: true });
  });

  // ---------- Idempotency: already completed ----------

  it('rejects POST with 409 when setup is already completed', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: 'https://rdc.tmnas.top',
      backendUrl: '',
      effectiveFrontendUrl: 'https://rdc.tmnas.top',
      effectiveBackendUrl: 'https://rdc.tmnas.top',
    });

    await expect(
      service.complete({ serverUrl: 'https://another.example.com' }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Nothing should have been written
    expect(mockGeneralSettings.updateSettings).not.toHaveBeenCalled();
    expect(mockWebClientSettings.updateSettings).not.toHaveBeenCalled();
  });

  // ---------- Invalid URLs ----------

  it('rejects serverUrl with a path', async () => {
    // First setup: not yet completed
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: '', backendUrl: '',
      effectiveFrontendUrl: 'http://localhost:3000',
      effectiveBackendUrl: 'http://localhost:3000',
    });

    await expect(
      service.complete({ serverUrl: 'https://example.com/some/path' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.complete({ serverUrl: 'https://example.com?x=1' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.complete({ serverUrl: 'https://example.com#frag' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.complete({ serverUrl: 'ftp://example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.complete({ serverUrl: 'https://user:pass@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.complete({ serverUrl: '  https://example.com  ' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mockGeneralSettings.updateSettings).not.toHaveBeenCalled();
  });

  // ---------- HTTPS: web client enabled with valid key ----------

  it('derives web client URLs and enables it when HTTPS + valid public key', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: '', backendUrl: '',
      effectiveFrontendUrl: 'http://localhost:3000',
      effectiveBackendUrl: 'http://localhost:3000',
    });
    mockGeneralSettings.getSettings.mockResolvedValue({
      watermarkEnabled: true,
      defaultLanguage: 'en-US',
      jwtExpiryDays: 30,
      auditRetentionDays: 0,
      deviceCloneIsolation: false,
      site: { frontendUrl: '', backendUrl: '' },
      webauthn: { enabled: true, rpName: 'RustDesk Console' },
    });

    const result = await service.complete({
      serverUrl: 'https://rdc.tmnas.top',
      serverPublicKey: VALID_PUBLIC_KEY,
    } satisfies CompleteSetupDto);

    expect(result.completed).toBe(true);
    expect(result.origin).toBe('https://rdc.tmnas.top');
    expect(result.webClient.eligible).toBe(true);
    expect(result.webClient.enabled).toBe(true);
    expect(result.webClient.idServerUrl).toBe('wss://rdc.tmnas.top/ws/id');
    expect(result.webClient.relayServerUrl).toBe('wss://rdc.tmnas.top/ws/relay');
    expect(result.webClient.allowedOrigin).toBe('https://rdc.tmnas.top');
    expect(result.warnings).toEqual([]);

    // Verify site URL was written (commit point)
    expect(mockGeneralSettings.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        site: { frontendUrl: 'https://rdc.tmnas.top', backendUrl: '' },
      }),
    );

    // Verify web client was configured
    expect(mockWebClientSettings.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        allowedOrigin: 'https://rdc.tmnas.top',
        idServerUrl: 'wss://rdc.tmnas.top/ws/id',
        relayServerUrl: 'wss://rdc.tmnas.top/ws/relay',
        serverPublicKey: VALID_PUBLIC_KEY,
      }),
    );
    expect(mockWebClient.refresh).toHaveBeenCalled();
  });

  // ---------- HTTPS: no key → disabled but addresses pre-filled ----------

  it('pre-fills web client addresses but keeps disabled when HTTPS but no key', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: '', backendUrl: '',
      effectiveFrontendUrl: 'http://localhost:3000',
      effectiveBackendUrl: 'http://localhost:3000',
    });
    mockGeneralSettings.getSettings.mockResolvedValue({
      watermarkEnabled: true,
      defaultLanguage: 'en-US',
      jwtExpiryDays: 30,
      auditRetentionDays: 0,
      deviceCloneIsolation: false,
      site: { frontendUrl: '', backendUrl: '' },
      webauthn: { enabled: true, rpName: 'RustDesk Console' },
    });

    const result = await service.complete({
      serverUrl: 'https://rdc.tmnas.top',
    } satisfies CompleteSetupDto);

    expect(result.webClient.eligible).toBe(true);
    expect(result.webClient.enabled).toBe(false);
    expect(result.webClient.idServerUrl).toBe('wss://rdc.tmnas.top/ws/id');
    expect(result.webClient.relayServerUrl).toBe('wss://rdc.tmnas.top/ws/relay');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'web_client_pending_key' }),
      ]),
    );

    expect(mockWebClientSettings.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        allowedOrigin: 'https://rdc.tmnas.top',
      }),
    );
    expect(mockWebClient.refresh).toHaveBeenCalled();
  });

  // ---------- HTTP origin: web client skipped ----------

  it('skips web client config and emits a warning when origin is HTTP', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: '', backendUrl: '',
      effectiveFrontendUrl: 'http://localhost:3000',
      effectiveBackendUrl: 'http://localhost:3000',
    });
    mockGeneralSettings.getSettings.mockResolvedValue({
      watermarkEnabled: true,
      defaultLanguage: 'en-US',
      jwtExpiryDays: 30,
      auditRetentionDays: 0,
      deviceCloneIsolation: false,
      site: { frontendUrl: '', backendUrl: '' },
      webauthn: { enabled: true, rpName: 'RustDesk Console' },
    });

    const result = await service.complete({
      serverUrl: 'http://192.168.1.100:8080',
      serverPublicKey: VALID_PUBLIC_KEY,
    } satisfies CompleteSetupDto);

    expect(result.origin).toBe('http://192.168.1.100:8080');
    expect(result.webClient.eligible).toBe(false);
    expect(result.webClient.enabled).toBe(false);
    expect(mockWebClientSettings.updateSettings).not.toHaveBeenCalled();
    expect(mockWebClient.refresh).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'http_only' }),
        expect.objectContaining({ code: 'web_client_skipped' }),
      ]),
    );

    // Site URL should still be written
    expect(mockGeneralSettings.updateSettings).toHaveBeenCalled();
  });

  // ---------- Password change: wrong password → nothing written ----------

  it('does not write any settings when admin password is wrong', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: '', backendUrl: '',
      effectiveFrontendUrl: 'http://localhost:3000',
      effectiveBackendUrl: 'http://localhost:3000',
    });
    mockUserRepo.findOne.mockResolvedValue({ guid: 'admin-guid' });
    mockUserService.changePassword.mockRejectedValue(
      new BadRequestException('Current password is incorrect'),
    );

    await expect(
      service.complete({
        serverUrl: 'https://rdc.tmnas.top',
        currentAdminPassword: 'wrong',
        newAdminPassword: 'newsecret',
      } satisfies CompleteSetupDto),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing should have been persisted
    expect(mockGeneralSettings.updateSettings).not.toHaveBeenCalled();
    expect(mockWebClientSettings.updateSettings).not.toHaveBeenCalled();
    expect(mockWebClient.refresh).not.toHaveBeenCalled();
  });

  // ---------- Password change: correct password + HTTPS ----------

  it('changes admin password, writes site URL, and configures web client with valid key', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: '', backendUrl: '',
      effectiveFrontendUrl: 'http://localhost:3000',
      effectiveBackendUrl: 'http://localhost:3000',
    });
    mockGeneralSettings.getSettings.mockResolvedValue({
      watermarkEnabled: true,
      defaultLanguage: 'en-US',
      jwtExpiryDays: 30,
      auditRetentionDays: 0,
      deviceCloneIsolation: false,
      site: { frontendUrl: '', backendUrl: '' },
      webauthn: { enabled: true, rpName: 'RustDesk Console' },
    });
    mockUserRepo.findOne.mockResolvedValue({ guid: 'admin-guid' });

    const result = await service.complete({
      serverUrl: 'https://rdc.tmnas.top',
      serverPublicKey: VALID_PUBLIC_KEY,
      currentAdminPassword: 'oldpass',
      newAdminPassword: 'newsecret',
    } satisfies CompleteSetupDto);

    expect(result.passwordChanged).toBe(true);
    expect(mockUserService.changePassword).toHaveBeenCalledWith(
      'admin-guid',
      { current_password: 'oldpass', new_password: 'newsecret' },
    );
    expect(mockGeneralSettings.updateSettings).toHaveBeenCalled();
    expect(mockWebClientSettings.updateSettings).toHaveBeenCalled();
  });

  // ---------- Password fields must appear together ----------

  it('rejects when only one of currentAdminPassword / newAdminPassword is provided', async () => {
    mockGeneralSettings.getSiteSettings.mockResolvedValue({
      frontendUrl: '', backendUrl: '',
      effectiveFrontendUrl: 'http://localhost:3000',
      effectiveBackendUrl: 'http://localhost:3000',
    });

    await expect(
      service.complete({
        serverUrl: 'https://rdc.tmnas.top',
        currentAdminPassword: 'oldpass',
      } as CompleteSetupDto),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.complete({
        serverUrl: 'https://rdc.tmnas.top',
        newAdminPassword: 'newsecret',
      } as CompleteSetupDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
