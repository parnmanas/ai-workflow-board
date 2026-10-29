import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { bindPublicUrlStore } from '../common/public-url';

/** Loads the remembered public address at boot so background jobs can build links before any request. */
@Injectable()
export class PublicUrlService implements OnModuleInit {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}
  onModuleInit() { return bindPublicUrlStore(this.ds); }
}
