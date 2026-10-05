import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../../entities/Account';
import { Ticket } from '../../entities/Ticket';
import { User } from '../../entities/User';
import { AccountsController } from './accounts.controller';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Account, Ticket, User]),
  ],
  controllers: [AccountsController],
  providers: [AuthGuard],
})
export class AccountsModule {}
