import {
  IsOptional,
  IsString,
  IsNotEmpty,
  Matches,
  MinLength,
} from 'class-validator';

/**
 * CompleteSetupDto
 * DTO for the setup wizard completion request.
 *
 * - serverUrl: required, the server origin (http/https only)
 * - serverPublicKey: optional, Ed25519 public key from Server Pro hbbs (Base64-encoded 32 bytes)
 * - adminUsername: required, the administrator account username for this install
 * - adminPassword: required, the administrator account password (min 6 chars)
 */
export class CompleteSetupDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^https?:\/\/[^\s?#]+$/, {
    message: 'serverUrl must be an http(s) origin without path/query/fragment',
  })
  serverUrl!: string;

  @IsOptional()
  @IsString()
  serverPublicKey?: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_.@-]+$/, {
    message: 'adminUsername may contain letters, numbers, dots, underscores, hyphens and @',
  })
  @MinLength(2)
  adminUsername!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6, { message: 'adminPassword must be at least 6 characters' })
  adminPassword!: string;
}
