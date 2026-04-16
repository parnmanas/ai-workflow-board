# Requirements: AI Workflow Board — v1.1 Admin 권한 관리 재구조화

**Defined:** 2026-04-13
**Core Value:** Admin이 cross-workspace로 사용자/Agent/권한을 관리하고, 일반 사용자는 할당된 workspace에만 접근하는 명확한 권한 구조.

## v1 Requirements

### Admin Menu Restructure

- [ ] **ADM-01**: Users 관리 메뉴가 Admin 레벨에서 전체 user 목록을 표시한다 (workspace 무관)
- [ ] **ADM-02**: AI Agents 관리 메뉴가 Admin 레벨에서 전체 agent 목록을 표시한다 (workspace 무관)
- [ ] **ADM-03**: API Keys 관리 메뉴가 Admin 레벨에서 전체 API key 목록을 표시한다 (workspace 무관)
- [ ] **ADM-04**: 기존 workspace 하위의 Users/AI Agents/API Keys 메뉴가 Admin으로 이동된다 (중복 제거)

### ReBACservice Permission Mapping UI

- [ ] **PERM-01**: Admin에서 user를 workspace에 member 또는 owner로 할당할 수 있다
- [ ] **PERM-02**: Admin에서 user의 workspace 관계를 해제(revoke)할 수 있다
- [ ] **PERM-03**: Admin에서 agent를 workspace에 할당할 수 있다
- [ ] **PERM-04**: Admin에서 agent의 workspace 관계를 해제할 수 있다
- [ ] **PERM-05**: 관계 현황 대시보드에서 user/agent↔workspace 매핑을 한눈에 볼 수 있다

### Workspace Access

- [ ] **WS-01**: 복수 workspace에 속한 사용자가 로그인 후 workspace 선택 화면을 본다
- [ ] **WS-02**: 사이드바 또는 헤더에서 다른 workspace로 전환할 수 있다

## Future Requirements

- **FUT-01**: Workspace 초대 링크 — URL로 workspace 가입
- **FUT-02**: Role 기반 세분화된 권한 (viewer/editor/admin per workspace)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Self-service workspace 생성 | Admin만 workspace 생성 — v1.1 범위 외 |
| SSO/OAuth workspace 매핑 | 현재 API key + 이메일 인증 유지 |
| Workspace별 설정/커스터마이징 | 권한 구조 정립 후 v1.2에서 검토 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ADM-01 | Phase 7 | Pending |
| ADM-02 | Phase 7 | Pending |
| ADM-03 | Phase 7 | Pending |
| ADM-04 | Phase 7 | Pending |
| PERM-01 | Phase 8 | Pending |
| PERM-02 | Phase 8 | Pending |
| PERM-03 | Phase 8 | Pending |
| PERM-04 | Phase 8 | Pending |
| PERM-05 | Phase 8 | Pending |
| WS-01 | Phase 9 | Pending |
| WS-02 | Phase 9 | Pending |

**Coverage:**
- v1 requirements: 11 total
- Mapped to phases: 11
- Unmapped: 0

---
*Requirements defined: 2026-04-13*
*Last updated: 2026-04-08 after roadmap creation (Phases 7-9)*
