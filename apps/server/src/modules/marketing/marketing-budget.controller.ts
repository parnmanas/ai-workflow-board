import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { MarketingCampaignService } from './marketing-campaign.service';
import { MarketingBudgetService } from './marketing-budget.service';
import { MarketingSpendService } from './marketing-spend.service';
import { allocationToJson, ledgerToJson, spendToJson } from './marketing-json';
import { errorStatus } from './marketing-errors';
import { assertCanViewMarketing, boundAccountId, userActor } from './marketing-http';

/**
 * 예산 편성 · 지출 · 원장 REST(docs/marketing.md "예산 편성 · 집행 · 결제"). 돈을 움직이는 모든 경로는
 * marketing.approve_spend 를 요구하고, 승인자는 로그인 세션의 사람이다. MCP 에는 이 경로들이 없다.
 */
@ApiBearerAuth('user-session')
@ApiTags('marketing')
@Controller('api/marketing')
@UseGuards(PermissionGuard)
export class MarketingBudgetController {
  constructor(
    private readonly campaigns: MarketingCampaignService,
    private readonly budget: MarketingBudgetService,
    private readonly spend: MarketingSpendService,
  ) {}

  @Get('campaigns/:id/budget')
  async summary(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      assertCanViewMarketing(req);
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      return res.json(await this.budget.summary(campaign));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to read budget' });
    }
  }

  @Get('campaigns/:id/allocations')
  async allocations(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      assertCanViewMarketing(req);
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      return res.json((await this.budget.listAllocations(campaign)).map(allocationToJson));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list allocations' });
    }
  }

  /** 사람이 직접 편성한다(approve: true 면 곧바로 승인까지). */
  @Post('campaigns/:id/allocations')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async createAllocations(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const accountId = boundAccountId(req);
      const campaign = await this.campaigns.get(id, accountId);
      const actor = userActor(req);
      const created = await this.budget.propose(campaign, body || {}, actor);
      let rows = created;
      if (body?.approve === true) {
        // 방금 만든 행만 승인한다 — 같은 사람이 예전에 남긴 다른 제안까지 휩쓸어 승인하지 않게.
        // 줄이는 편성을 먼저 승인한다: 재배분(한쪽을 줄이고 다른 쪽을 늘림)이 중간에 상한을 넘었다고 거부되지 않게.
        const deltas = await Promise.all(created.map(async (row) => {
          const current = await this.budget.activeFor(campaign.id, row.channel_id);
          return { row, delta: row.amount_minor - (current ? current.amount_minor : 0) };
        }));
        deltas.sort((a, b) => a.delta - b.delta);
        rows = [];
        for (const { row } of deltas) rows.push(await this.budget.approve(row.id, accountId, actor, 'set directly'));
      }
      return res.status(201).json(rows.map(allocationToJson));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to create allocations' });
    }
  }

  @Post('allocations/:id/approve')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async approveAllocation(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(allocationToJson(await this.budget.approve(id, boundAccountId(req), userActor(req), String(body?.note || ''))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to approve allocation' });
    }
  }

  @Post('allocations/:id/reject')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async rejectAllocation(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(allocationToJson(await this.budget.reject(id, boundAccountId(req), userActor(req), String(body?.note || ''))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to reject allocation' });
    }
  }

  @Get('campaigns/:id/spend-requests')
  async listSpend(@Param('id') id: string, @Query('status') status: string, @Query('limit') limit: string, @Req() req: Request, @Res() res: Response) {
    try {
      assertCanViewMarketing(req);
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      return res.json((await this.spend.list(campaign, status || undefined, limit ? Number(limit) : 100)).map(spendToJson));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to list spend requests' });
    }
  }

  @Get('spend-requests/:id')
  async getSpend(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      assertCanViewMarketing(req);
      const row = await this.spend.get(id, boundAccountId(req));
      return res.json({ ...spendToJson(row), ledger: (await this.spend.ledgerFor(row.id)).map(ledgerToJson) });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Spend request not found' });
    }
  }

  @Post('spend-requests/:id/approve')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async approveSpend(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const { request, final } = await this.spend.approve(id, boundAccountId(req), userActor(req), String(body?.payload_sha256 || ''), String(body?.note || ''));
      return res.status(200).json({ ...spendToJson(request), final });
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to approve spend' });
    }
  }

  @Post('spend-requests/:id/deny')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async denySpend(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(spendToJson(await this.spend.deny(id, boundAccountId(req), userActor(req), String(body?.note || ''))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to deny spend' });
    }
  }

  @Post('spend-requests/:id/cancel')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async cancelSpend(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(spendToJson(await this.spend.cancel(id, boundAccountId(req), userActor(req), String(body?.note || ''))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to cancel spend' });
    }
  }

  @Post('spend-requests/:id/mark-paid')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async markPaid(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(spendToJson(await this.spend.markPaid(id, boundAccountId(req), userActor(req), body || {})));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to record payment' });
    }
  }

  @Post('spend-requests/:id/mark-failed')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async markFailed(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(spendToJson(await this.spend.markFailed(id, boundAccountId(req), userActor(req), String(body?.note || ''))));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to record failure' });
    }
  }

  @Post('spend-requests/:id/refund')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async refund(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(spendToJson(await this.spend.refund(id, boundAccountId(req), userActor(req), body || {})));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to record refund' });
    }
  }

  /**
   * 연결 확인(읽기 전용) — 직접 공급자 경로가 있는 수취인마다 credential 과 대상을 읽어 본다. 공급자 계정을 실제로 읽는 일이라
   * 돈 설정과 같은 권한(approve_spend)에만 연다. 쓰기는 하나도 없다.
   */
  @Post('campaigns/:id/payment/check')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async checkPayments(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      return res.status(200).json(await this.spend.checkPayments(campaign, userActor(req)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to check payment connections' });
    }
  }

  /** 요청별 공급자 확인(읽기 전용) — 결과 불명을 대조할 때 지금 상한이 from · to 중 어디인지. */
  @Post('spend-requests/:id/inspect')
  @RequirePermission(PERMISSIONS.APPROVE_MARKETING_SPEND)
  async inspectSpend(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      return res.status(200).json(await this.spend.inspect(id, boundAccountId(req)));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to inspect the payment target' });
    }
  }

  @Get('campaigns/:id/ledger')
  async ledger(@Param('id') id: string, @Query('limit') limit: string, @Req() req: Request, @Res() res: Response) {
    try {
      assertCanViewMarketing(req);
      const campaign = await this.campaigns.get(id, boundAccountId(req));
      return res.json((await this.budget.listLedger(campaign, limit ? Number(limit) : 200)).map(ledgerToJson));
    } catch (e: any) {
      return res.status(errorStatus(e)).json({ error: e?.message || 'Failed to read ledger' });
    }
  }
}
