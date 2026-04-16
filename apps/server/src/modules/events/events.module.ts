import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsController } from './events.controller';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket, BoardColumn])],
  controllers: [EventsController],
})
export class EventsModule {}
