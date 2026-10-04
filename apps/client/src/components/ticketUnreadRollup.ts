/**
 * 티켓 자신의 미읽음 코멘트 수를 모든 서브태스크의 수와 재귀적으로
 * 합산한다 — 티켓 목록 행(TicketCard)의 children 은 root→child→grandchild 로
 * 중첩된다. 서브태스크는 Tickets 페이지에 자기 카드/행을 렌더하지 않으므로,
 * 이 롤업이 없으면 서브태스크의 코멘트가 사이드바 뱃지 합계엔 잡히지만 어느
 * 카드에도 나타나지 않는다 — 티켓 628f4b39가 지적하는 "이 숫자가 어디서
 * 왔는지" 갭.
 *
 * React 없는 순수 함수라 `node --test`로 바로 단위 테스트할 수 있다
 * (sidebarRoomsPaging.ts가 Sidebar 페이징 로직을 추출한 것과 동일한 패턴).
 */
export function sumUnread(
  ticket: { id: string; children?: Array<{ id: string; children?: any[] }> },
  perTicket: Record<string, number>,
): number {
  let total = perTicket[ticket.id] || 0;
  for (const child of ticket.children || []) total += sumUnread(child, perTicket);
  return total;
}
