import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { ColumnRolePolicy } from '../../entities/ColumnRolePolicy';
import { ColumnRolePolicyService } from './column-role-policy.service';
import { ColumnPoliciesController } from './column-policies.controller';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

/**
 * ColumnPoliciesModule — ticket f886ada7. Owns:
 *   - `ColumnRolePolicyService` (lookup + glob matching), exported so
 *     `StuckTicketDetectorService` can consult it during its sweep.
 *   - `ColumnPoliciesController` (admin REST CRUD for the table).
 *
 * No background workers — enforcement piggy-backs on the existing stuck
 * detector loop so the sweep budget envelope stays unchanged.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Board, BoardColumn, ColumnRolePolicy])],
  providers: [ColumnRolePolicyService, AdminGuard, AuthGuard, PermissionGuard],
  controllers: [ColumnPoliciesController],
  exports: [ColumnRolePolicyService],
})
export class ColumnPoliciesModule {}
