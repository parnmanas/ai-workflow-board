import { ApiProperty } from '@nestjs/swagger';

// Swagger-only DTOs. Controllers still use `@Body() body: any` for runtime
// handling — these classes exist to describe the request shape in
// /api-docs-json so the "Try it out" panel renders editable fields instead
// of a generic empty body.

export class LoginDto {
  @ApiProperty({ example: 'alice@example.com' })
  email!: string;

  @ApiProperty({ example: 'hunter2', description: 'Plaintext — hashed server-side.' })
  password!: string;
}

export class RegisterDto {
  @ApiProperty({ example: 'alice@example.com' })
  email!: string;

  @ApiProperty({ example: 'hunter2' })
  password!: string;

  @ApiProperty({ required: false, example: 'Alice' })
  name?: string;
}

export class SetupDto {
  @ApiProperty({ example: 'admin@example.com', description: 'First-time initial-admin email. Blocked once any user exists.' })
  email!: string;

  @ApiProperty({ example: 'hunter2' })
  password!: string;

  @ApiProperty({ required: false, example: 'Admin' })
  name?: string;
}
