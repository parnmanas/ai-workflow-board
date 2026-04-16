import { Controller, Get } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Controller('api')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get('health')
  async getHealth() {
    let dbStatus = 'ok';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      dbStatus = 'unavailable';
    }
    return {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      database: dbStatus,
      mcp: true,
      timestamp: new Date().toISOString(),
    };
  }
}
