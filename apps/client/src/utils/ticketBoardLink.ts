export interface TicketBoardRef {
  id: string;
  board_id?: string | null;
  workspace_id?: string | null;
  archived_at?: string | null;
}

// board_id 를 못 찾았거나(고아/삭제된 column) 아카이브된 티켓은 보드에서 열 수 없다.
// "보드에서 열기" 버튼(티켓 7815a958)과 Agent 상세 current task 클릭(티켓 dc5c0813)이
// 공유하는 판정 — workspace_id 유무는 관여하지 않는다(ticketBoardPath 에서 경로 조합에만 씀).
export function canOpenTicketOnBoard(t: TicketBoardRef): boolean {
  return !!t.board_id && !t.archived_at;
}

export function ticketBoardPath(t: TicketBoardRef): string {
  return `/ws/${t.workspace_id}/boards/${t.board_id}?ticket=${encodeURIComponent(t.id)}`;
}
