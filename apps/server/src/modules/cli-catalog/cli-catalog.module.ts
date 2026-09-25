import { Module } from '@nestjs/common';
import { CliCatalogController } from './cli-catalog.controller';

@Module({
  controllers: [CliCatalogController],
})
export class CliCatalogModule {}
