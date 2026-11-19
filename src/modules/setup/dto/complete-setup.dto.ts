import {
  IsOptional,
  IsString,
  IsNotEmpty,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * CompleteSetupDto
 * DTO for the setup wizard completion request.
 *
 * - serverUrl: required, the server origin (http/https only)
 * - serverPublicKey: optional, Ed25519 public key from Server Pro hbbs (Base64-encoded 32 bytes)
 * - currentAdminPassword / newAdminPassword: optional pair to reset the admin password
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

  @IsOptional()
  @IsString()
  @ValidateIf((_, v) => v !== undefined && v !== '')
  currentAdminPassword?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  newAdminPassword?: string;
}
