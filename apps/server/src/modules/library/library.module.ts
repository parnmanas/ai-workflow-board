import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LibraryItem } from '../../entities/LibraryItem';
import { Resource } from '../../entities/Resource';
import { LibraryController } from './library.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([LibraryItem, Resource])],
  controllers: [LibraryController],
  providers: [AuthGuard],
})
export class LibraryModule {}
